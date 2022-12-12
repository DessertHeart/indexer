import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();
import { baseProvider } from "@/common/provider";
import { getEventsFromTx } from "../utils/test";
import { handleEvents } from "@/events-sync/handlers/nftx";
import { Interface } from "@ethersproject/abi";
import { Contract } from "@ethersproject/contracts";
import { formatEther, parseEther } from "@ethersproject/units";
import { logger } from "@/common/logger";
import * as orders from "@/orderbook/orders";

async function getNFTxPoolPrice(id: string, type: string) {
  let buyPrice = null;
  let sellPrice = null;
  let assetAddress = null;
  let vaultAddress = null;

  const iface = new Interface([
    "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
    "function getAmountsIn(uint amountOut, address[] memory path) view returns (uint[] memory amounts)",
  ]);
  const vaultFactoryAddress = "0xBE86f647b167567525cCAAfcd6f881F1Ee558216";
  const factory = new Contract(
    vaultFactoryAddress,
    ["function vault(uint256 vaultId) external view returns (address)"],
    baseProvider
  );

  vaultAddress = type === "id" ? await factory.vault(id) : id;
  const vault = new Contract(
    vaultAddress,
    ["function assetAddress() view returns (address)"],
    baseProvider
  );

  assetAddress = await vault.assetAddress();
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  const sushiRouter = new Contract(
    "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    iface,
    baseProvider
  );

  try {
    const amounts = await sushiRouter.getAmountsIn(parseEther("1"), [WETH, vaultAddress]);
    buyPrice = formatEther(amounts[0]);
  } catch (error) {
    logger.error("get-nftx-pool-price", `Failed to getAmountsIn: ${error}`);
  }

  try {
    const amounts = await sushiRouter.getAmountsOut(parseEther("1"), [vaultAddress, WETH]);
    sellPrice = formatEther(amounts[1]);
  } catch (error) {
    logger.error("get-nftx-pool-price", `Failed to getAmountsOut: ${error}`);
  }

  return {
    asset: assetAddress,
    vault: vaultAddress,
    price: {
      sell: sellPrice,
      buy: buyPrice,
    },
  };
}

jest.setTimeout(1000 * 1000);

describe("NFTX", () => {
  test("has-orders", async () => {
    const tx = await baseProvider.getTransactionReceipt(
      "0xab53ee4ea3653b0956fd8a6dd4a01b20775f65fcc7badc3b6e20481316f6b1f0"
    );
    const events = await getEventsFromTx(tx);
    const result = await handleEvents(events);
    const order = result?.orders?.find((c) => c.kind === "nftx");
    expect(order).not.toBe(null);
  });

  test("get-pooprice", async () => {
    const info = await getNFTxPoolPrice("392", "id");
    expect(info.asset).toBe("0x5Af0D9827E0c53E4799BB226655A1de152A425a5");
    if (info?.price?.buy) {
      expect(parseFloat(info.price.buy)).toBeGreaterThan(parseFloat("0.4"));
    }
  });

  test("order-saving", async () => {

    const tx = await baseProvider.getTransactionReceipt(
      "0xab53ee4ea3653b0956fd8a6dd4a01b20775f65fcc7badc3b6e20481316f6b1f0"
    );
    const events = await getEventsFromTx(tx);
    const result = await handleEvents(events);
    const order = result?.orders?.find((c) => c.kind === "nftx");
    
    // collectionsRefreshCache.addToQueue("0x6be69b2a9b153737887cfcdca7781ed1511c7e36")
    
    expect(order).not.toBe(null);

    const orderInfo: orders.nftx.OrderInfo = order?.info as orders.nftx.OrderInfo;

    // Store order to database
    await orders.nftx.save([orderInfo]);

    // const orderInDb = await getOrder(
    //   "0x71ba349119ef6685a84da0ccd810ec3070345608fe981619f071ad268b499eba"
    // );

    // await wait(20 * 1000);
    // console.log("orderInDb", orderInDb);
    // expect(orderInDb).not.toBe(null);
  });
});
