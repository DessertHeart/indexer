import { Queue, QueueScheduler, Worker } from "bullmq";

import cron from "node-cron";
import { logger } from "@/common/logger";
import { redis, redlock } from "@/common/redis";
import { config } from "@/config/index";
import { randomUUID } from "crypto";
import { BidEventsList } from "@/models/bid-events-list";
import { idb, pgp } from "@/common/db";
import { toBuffer } from "@/common/utils";
import _ from "lodash";

const QUEUE_NAME = "save-bid-events-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 10000,
    },
    removeOnComplete: 1000,
    removeOnFail: 10000,
    timeout: 30000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const bidEventsList = new BidEventsList();
      const events = await bidEventsList.get(750);

      const columns = new pgp.helpers.ColumnSet(
        [
          "kind",
          "status",
          "contract",
          "token_set_id",
          "order_id",
          "order_source_id_int",
          "order_valid_between",
          "order_quantity_remaining",
          "order_nonce",
          "maker",
          "price",
          "value",
          "tx_hash",
          "tx_timestamp",
          "order_kind",
          "order_currency",
          "order_currency_price",
          "order_normalized_value",
          "order_currency_normalized_value",
          "order_raw_data",
        ],
        { table: "bid_events" }
      );

      const data = events.map((event) => {
        if (!event.trigger.kind) {
          logger.error(QUEUE_NAME, `no trigger kind for ${event}`);
          continue;
        }

        let status = "active";

        switch (event.order.fillabilityStatus) {
          case "filled":
            status = "filled";
            break;

          case "cancelled":
            status = "cancelled";
            break;

          case "expired":
            status = "expired";
            break;

          case "no-balance":
          case "no-approval":
            status = "inactive";
            break;
        }

        return {
          kind: event.order.fillabilityStatus,
          status,
          contract: toBuffer(event.order.contract),
          token_set_id: event.order.tokenSetId,
          order_id: event.order.id,
          order_source_id_int: event.order.sourceIdInt,
          order_valid_between: event.order.validBetween,
          order_quantity_remaining: event.order.quantityRemaining,
          order_nonce: event.order.nonce,
          maker: toBuffer(event.order.maker),
          price: event.order.price,
          value: event.order.value,
          tx_hash: event.trigger.txHash ? toBuffer(event.trigger.txHash) : null,
          tx_timestamp: event.trigger.txTimestamp || null,
          order_kind: event.order.kind,
          order_currency: toBuffer(event.order.currency),
          order_currency_price: event.order.currency_price,
          order_normalized_value: event.order.normalized_value,
          order_currency_normalized_value: event.order.currency_normalized_value,
          order_raw_data: event.order.raw_data,
        };
      });

      if (!_.isEmpty(data)) {
        try {
          const query = pgp.helpers.insert(data, columns) + " ON CONFLICT DO NOTHING";
          await idb.none(query);
          job.data.checkForMore = true;
        } catch (error) {
          logger.error(QUEUE_NAME, `failed to insert into bid_events ${error}`);
          await bidEventsList.add(events);
        }
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });

  worker.on("completed", async (job) => {
    if (job.data.checkForMore) {
      await addToQueue();
    }
  });
}

export const addToQueue = async () => {
  await queue.add(randomUUID(), {});
};

if (config.doBackgroundWork) {
  cron.schedule(
    "*/10 * * * * *",
    async () =>
      await redlock
        .acquire(["save-bid-events"], (10 - 5) * 1000)
        .then(async () => addToQueue())
        .catch(() => {
          // Skip on any errors
        })
  );
}
