import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { idb, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { toBuffer } from "@/common/utils";
import { config } from "@/config/index";

const QUEUE_NAME = "collection-updates-normalized-floor-ask-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 20000,
    },
    removeOnComplete: 1000,
    removeOnFail: 10000,
    timeout: 60000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { kind, contract, tokenId, txHash, txTimestamp } = job.data as FloorAskInfo;

      try {
        // First, retrieve the token's associated collection.
        const collectionResult = await redb.oneOrNone(
          `
            SELECT tokens.collection_id FROM tokens
            WHERE tokens.contract = $/contract/
              AND tokens.token_id = $/tokenId/
          `,
          {
            contract: toBuffer(contract),
            tokenId,
          }
        );

        if (!collectionResult?.collection_id) {
          // Skip if the token is not associated to a collection.
          return;
        }

        await idb.none(
          `
            WITH y AS (
              UPDATE collections SET
                normalized_floor_sell_id = x.normalized_floor_sell_id,
                normalized_floor_sell_value = x.normalized_floor_sell_value,
                normalized_floor_sell_maker = x.normalized_floor_sell_maker,
                normalized_floor_sell_source_id_int = x.source_id_int,
                normalized_floor_sell_valid_between = x.valid_between,
                updated_at = now()
              FROM (
                WITH collection_normalized_floor_sell AS (
                    SELECT
                      tokens.normalized_floor_sell_id,
                      tokens.normalized_floor_sell_value,
                      tokens.normalized_floor_sell_maker,
                      orders.source_id_int,
                      orders.valid_between
                    FROM tokens
                    JOIN orders ON tokens.normalized_floor_sell_id = orders.id
                    WHERE tokens.collection_id = $/collection/
                    ORDER BY tokens.normalized_floor_sell_value
                    LIMIT 1
                )
                SELECT
                    collection_normalized_floor_sell.normalized_floor_sell_id,
                    collection_normalized_floor_sell.normalized_floor_sell_value,
                    collection_normalized_floor_sell.normalized_floor_sell_maker,
                    collection_normalized_floor_sell.source_id_int,
                    collection_normalized_floor_sell.valid_between
                FROM collection_normalized_floor_sell
                UNION ALL
                SELECT NULL, NULL, NULL, NULL, NULL
                WHERE NOT EXISTS (SELECT 1 FROM collection_normalized_floor_sell)
              ) x
              WHERE collections.id = $/collection/
                AND (
                  collections.normalized_floor_sell_id IS DISTINCT FROM x.normalized_floor_sell_id
                  OR collections.normalized_floor_sell_value IS DISTINCT FROM x.normalized_floor_sell_value
                )
              RETURNING
                collections.normalized_floor_sell_id,
                collections.normalized_floor_sell_value,
                (
                  SELECT
                    collections.normalized_floor_sell_value
                  FROM collections
                  WHERE id = $/collection/
                ) AS old_normalized_floor_sell_value,
                collections.normalized_floor_sell_maker,
                collections.normalized_floor_sell_source_id_int,
                collections.normalized_floor_sell_valid_between
            )
            INSERT INTO collection_normalized_floor_sell_events(
              kind,
              collection_id,
              contract,
              token_id,
              order_id,
              order_source_id_int,
              order_valid_between,
              maker,
              price,
              previous_price,
              tx_hash,
              tx_timestamp
            )
            SELECT
              $/kind/::token_floor_sell_event_kind_t,
              $/collection/,
              z.contract,
              z.token_id,
              y.normalized_floor_sell_id,
              y.normalized_floor_sell_source_id_int,
              y.normalized_floor_sell_valid_between,
              y.normalized_floor_sell_maker,
              y.normalized_floor_sell_value,
              y.old_normalized_floor_sell_value,
              $/txHash/,
              $/txTimestamp/
            FROM y
            LEFT JOIN LATERAL (
              SELECT
                token_sets_tokens.contract,
                token_sets_tokens.token_id
              FROM token_sets_tokens
              JOIN orders
                ON token_sets_tokens.token_set_id = orders.token_set_id
              WHERE orders.id = y.normalized_floor_sell_id
              LIMIT 1
            ) z ON TRUE
          `,
          {
            kind,
            collection: collectionResult.collection_id,
            contract: toBuffer(contract),
            tokenId,
            txHash: txHash ? toBuffer(txHash) : null,
            txTimestamp,
          }
        );
      } catch (error) {
        logger.error(
          QUEUE_NAME,
          `Failed to process collection normalized floor-ask info ${JSON.stringify(
            job.data
          )}: ${error}`
        );
        throw error;
      }
    },
    { connection: redis.duplicate(), concurrency: 5 }
  );
  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type FloorAskInfo = {
  kind: string;
  contract: string;
  tokenId: string;
  txHash: string | null;
  txTimestamp: number | null;
};

export const addToQueue = async (floorAskInfos: FloorAskInfo[]) => {
  await queue.addBulk(
    floorAskInfos.map((floorAskInfo) => ({
      name: `${floorAskInfo.contract}-${floorAskInfo.tokenId}`,
      data: floorAskInfo,
    }))
  );
};
