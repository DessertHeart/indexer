import { Kafka, Producer, logLevel } from "kafkajs";

import { config } from "@/config/index";
import { TopicHandlers } from "@/jobs/cdc/topics";
import { logger } from "@/common/logger";

const kafka = new Kafka({
  clientId: config.kafkaClientId,
  brokers: config.kafkaBrokers,
  logLevel: logLevel.ERROR,
});

export let producer: Producer;
export const consumer = kafka.consumer({
  groupId: config.kafkaConsumerGroupId,
  maxBytesPerPartition: config.kafkaMaxBytesPerPartition || 1048576, // (default is 1MB)
});

export async function startKafkaProducer(): Promise<void> {
  producer = kafka.producer();
  logger.info(`kafka-producer`, "Starting Kafka producer");
  await producer.connect();

  const connectPromise = new Promise((resolve, reject) => {
    producer.on("producer.connect", async () => {
      logger.info(`kafka-producer`, "Producer connected");
      resolve(undefined);
    });

    setTimeout(() => {
      reject("Producer connection timeout");
    }, 20000);
  });

  await connectPromise;

  producer.on("producer.disconnect", async (error) => {
    logger.error(`kafka-producer`, `Producer disconnected, error=${error}`);
    await restartKafkaProducer();
  });
}

export async function startKafkaConsumer(): Promise<void> {
  logger.info(`kafka-consumer`, "Starting Kafka consumer");
  await consumer.connect();

  const topicsToSubscribe = TopicHandlers.map((topicHandler) => {
    return topicHandler.getTopics();
  }).flat();

  logger.info(`kafka-consumer`, `Subscribing to topics=${JSON.stringify(topicsToSubscribe)}`);

  // Do this one at a time, as sometimes the consumer will re-create a topic that already exists if we use the method to subscribe to all topics at once and
  // one of the topics do not exist.
  await Promise.all(
    topicsToSubscribe.map(async (topic) => {
      await consumer.subscribe({ topic });
    })
  );

  await consumer.run({
    partitionsConsumedConcurrently: config.kafkaPartitionsConsumedConcurrently,

    eachBatchAutoResolve: true,

    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      const messagePromises = batch.messages.map(async (message) => {
        try {
          const event = JSON.parse(message.value!.toString());

          if (batch.topic.endsWith("-dead-letter")) {
            logger.info(
              `kafka-consumer`,
              `Dead letter topic=${batch.topic}, message=${JSON.stringify(event)}`
            );
            return;
          }

          for (const handler of TopicHandlers) {
            if (handler.getTopics().includes(batch.topic)) {
              if (!event.retryCount) {
                event.retryCount = 0;
              }

              await handler.handle(event, message.offset);
              break;
            }
          }

          await resolveOffset(message.offset);
        } catch (error) {
          try {
            logger.error(
              `kafka-consumer`,
              `Error handling topic=${batch.topic}, error=${error}, payload=${JSON.stringify(
                message
              )}`
            );

            const newMessage = {
              error: JSON.stringify(error),
              value: message.value,
            };

            await producer.send({
              topic: `${batch.topic}-dead-letter`,
              messages: [newMessage],
            });
          } catch (error) {
            logger.error(
              `kafka-consumer`,
              `Error sending to dead letter topic=${batch.topic}, error=${error}}`
            );
          }
        }
      });

      await Promise.all(messagePromises);
      await heartbeat();
    },
  });

  consumer.on("consumer.crash", async (error) => {
    logger.error(`kafka-consumer`, `Consumer crashed, error=${error}`);
    await restartKafkaConsumer();
  });

  consumer.on("consumer.disconnect", async (error) => {
    logger.error(`kafka-consumer`, `Consumer disconnected, error=${error}`);
    await restartKafkaConsumer();
  });
}

// This can be used to restart the Kafka consumer, for example if the consumer is disconnected, or if we need to subscribe to new topics as
// we cannot subscribe to new topics while the consumer is running.
export async function restartKafkaConsumer(): Promise<void> {
  try {
    await consumer.disconnect();
  } catch (error) {
    logger.error(`kafka-consumer`, `Error disconnecting consumer, error=${error}`);
  }
  await startKafkaConsumer();
}

export async function restartKafkaProducer(): Promise<void> {
  try {
    await producer.disconnect();
  } catch (error) {
    logger.error(`kafka-producer`, `Error disconnecting producer, error=${error}`);
  }
  await startKafkaProducer();
}
