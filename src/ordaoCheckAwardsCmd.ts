import { Command } from "commander";
import { readTargetFrappType } from "./readFrapps.js";
import { zOrdaoFrapp } from "./types/ordaoFrapp.js";
import { readFullCfg } from "./readFullOrdaoCfg.js";
import { MongoClient } from "mongodb";
import { JsonRpcProvider, WebSocketProvider, ZeroAddress, toBeHex, toBigInt, zeroPadValue, toBeArray, dataSlice } from "ethers";
import type { Provider } from "ethers";
import { Respect1155__factory } from "@ordao/respect1155/typechain-types/index.js";
import { zRespectAwardMt } from "@ordao/ortypes/respect1155.js";
import { chainInfos } from "./chainInfos.js";
import { NetworkId } from "./types/baseDeploymentCfg.js";

interface ChainMintEvent {
  tokenId: string;       // hex, 32 bytes
  to: string;            // recipient address
  value: bigint;
  txHash: string;
  blockNumber: number;
  denomination?: number; // looked up from contract
}

interface DbAward {
  tokenId: string;
  recipient: string;
  denomination: number;
  periodNumber: number;
  mintType: number;
  mintTxHash?: string;
  burned: boolean;
}

export const ordaoCheckAwardsCmd = new Command("check-awards")
  .argument("[targets...]", "frapp ids to check. 'all' stands for all frapps", "all")
  .option("-f, --from-block <from-block>", "from block (default: 0)", "0")
  .option("-t, --to-block <to-block>", "to block (default: latest)", "latest")
  .option("-s, --step-range <step-range>", "block range per query step", "50000")
  .option("-r, --rpc-url <rpc-url>", "override RPC URL")
  .showHelpAfterError()
  .description("Check consistency between on-chain respect mint events and awards stored in ornode DB. Outputs discrepancies.")
  .action(async (targets: string[], opts) => {
    const fromBlock = Number.parseInt(opts.fromBlock);
    const toBlockStr: string = opts.toBlock;
    const stepRange = Number.parseInt(opts.stepRange);
    const rpcUrlOverride: string | undefined = opts.rpcUrl;

    const frapps = readTargetFrappType(zOrdaoFrapp, targets);

    for (const frapp of frapps) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Checking frapp: ${frapp.id} (${frapp.fullName})`);
      console.log("=".repeat(60));

      try {
        const fullCfg = readFullCfg(frapp);

        const newRespectAddr = fullCfg.deployment.newRespect;
        const network = fullCfg.deploymentCfg.network as NetworkId;
        // Prefer public HTTP RPCs for getLogs (WSS endpoints often reject eth_getLogs)
        const rpcUrl = rpcUrlOverride ?? chainInfos[network]?.rpcUrls[0] ?? fullCfg.localOnly.providerUrl;

        if (!rpcUrl) {
          console.error(`No RPC URL available for frapp ${frapp.id}`);
          continue;
        }

        const mongoUrl: string = (fullCfg.localOnly.mongoCfg as any).url;
        const dbName: string = (fullCfg.localOnly.mongoCfg as any).dbName;

        console.log(`Contract: ${newRespectAddr}`);
        console.log(`RPC: ${rpcUrl}`);
        console.log(`MongoDB: ${dbName}`);

        // 1. Query on-chain mint events
        const isWs = rpcUrl.startsWith("wss://") || rpcUrl.startsWith("ws://");
        const provider: JsonRpcProvider | WebSocketProvider = isWs
          ? new WebSocketProvider(rpcUrl)
          : new JsonRpcProvider(rpcUrl);
        const respect = Respect1155__factory.connect(newRespectAddr, provider);

        const chainMints = await queryChainMints(
          respect, provider, fromBlock, toBlockStr, stepRange
        );
        console.log(`\nOn-chain mint events found: ${chainMints.length}`);

        // 2. Query DB awards
        const mgClient = new MongoClient(mongoUrl);
        try {
          const db = mgClient.db(dbName);
          const awardsCollection = db.collection('awards');
          const rawAwards = await awardsCollection.find({}, { projection: { _id: 0 } }).toArray();

          const dbAwards: DbAward[] = rawAwards.map(doc => {
            const award = zRespectAwardMt.parse(doc);
            return {
              tokenId: award.properties.tokenId,
              recipient: award.properties.recipient,
              denomination: award.properties.denomination,
              periodNumber: award.properties.periodNumber,
              mintType: award.properties.mintType,
              mintTxHash: award.properties.mintTxHash,
              burned: award.properties.burn !== null && award.properties.burn !== undefined,
            };
          });

          const activeDbAwards = dbAwards.filter(a => !a.burned);
          const burnedDbAwards = dbAwards.filter(a => a.burned);

          console.log(`DB awards total: ${dbAwards.length} (active: ${activeDbAwards.length}, burned: ${burnedDbAwards.length})`);

          // 3. Compare
          await compareAndReport(chainMints, dbAwards, respect);

        } finally {
          await mgClient.close();
        }

        if (provider instanceof WebSocketProvider) {
          await provider.destroy();
        } else {
          provider.destroy();
        }
      } catch (err) {
        console.error(`Error checking frapp ${frapp.id}:`, err);
      }
    }
  });


async function queryChainMints(
  respect: ReturnType<typeof Respect1155__factory.connect>,
  provider: Provider,
  fromBlock: number,
  toBlockStr: string,
  stepRange: number,
): Promise<ChainMintEvent[]> {
  const mints: ChainMintEvent[] = [];

  const latestBlock = await provider.getBlockNumber();
  const toBlock = toBlockStr === "latest" ? latestBlock : Number.parseInt(toBlockStr);

  const tsingleSig = "TransferSingle(address,address,address,uint256,uint256)";
  const tbatchSig = "TransferBatch(address,address,address,uint256[],uint256[])";

  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + stepRange - 1, toBlock);
    process.stdout.write(`  Querying blocks ${from}-${to}...\r`);

    const logs = await provider.getLogs({
      fromBlock: from,
      toBlock: to,
      address: await respect.getAddress(),
    });

    for (const log of logs) {
      const parsed = respect.interface.parseLog(log);
      if (!parsed) continue;

      if (parsed.signature === tsingleSig) {
        const from_ = parsed.args[1] as string;
        const to_ = parsed.args[2] as string;
        const id = parsed.args[3] as bigint;
        const value = parsed.args[4] as bigint;

        if (from_.toLowerCase() === ZeroAddress.toLowerCase() && to_.toLowerCase() !== ZeroAddress.toLowerCase()) {
          // Skip fungible token (id === 0n)
          if (id !== 0n) {
            mints.push({
              tokenId: toBeHex(id, 32),
              to: to_,
              value,
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            });
          }
        }
      } else if (parsed.signature === tbatchSig) {
        const from_ = parsed.args[0 + 1] as string;
        const to_ = parsed.args[0 + 2] as string;
        const ids = parsed.args[0 + 3] as bigint[];
        const values = parsed.args[0 + 4] as bigint[];

        if (from_.toLowerCase() === ZeroAddress.toLowerCase() && to_.toLowerCase() !== ZeroAddress.toLowerCase()) {
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (id !== 0n) {
              mints.push({
                tokenId: toBeHex(id, 32),
                to: to_,
                value: values[i],
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
              });
            }
          }
        }
      }
    }

    from = to + 1;
  }
  console.log(); // newline after progress

  return mints;
}


function unpackTokenIdSimple(tokenId: string): { periodNumber: number; owner: string; mintType: number } {
  const bytes = zeroPadValue(toBeArray(tokenId), 32);
  const mintType = Number(toBigInt(dataSlice(bytes, 3, 4)));
  const periodNumber = Number(toBigInt(dataSlice(bytes, 4, 12)));
  const owner = dataSlice(bytes, 12, 32);
  return { mintType, periodNumber, owner };
}


async function compareAndReport(
  chainMints: ChainMintEvent[],
  dbAwards: DbAward[],
  respect: ReturnType<typeof Respect1155__factory.connect>,
) {
  // Build lookup maps
  const chainByTokenId = new Map<string, ChainMintEvent[]>();
  for (const m of chainMints) {
    const key = m.tokenId.toLowerCase();
    if (!chainByTokenId.has(key)) chainByTokenId.set(key, []);
    chainByTokenId.get(key)!.push(m);
  }

  const dbByTokenId = new Map<string, DbAward[]>();
  for (const a of dbAwards) {
    const key = a.tokenId.toLowerCase();
    if (!dbByTokenId.has(key)) dbByTokenId.set(key, []);
    dbByTokenId.get(key)!.push(a);
  }

  const allTokenIds = new Set<string>([
    ...chainByTokenId.keys(),
    ...dbByTokenId.keys(),
  ]);

  let onChainOnly: ChainMintEvent[] = [];
  let dbOnly: DbAward[] = [];
  let countMatch = 0;
  let denominationMismatches: { tokenId: string; chainDenom: number; dbDenom: number }[] = [];

  // For on-chain-only tokens, look up denomination from the contract
  for (const tokenId of allTokenIds) {
    const chainEntries = chainByTokenId.get(tokenId) ?? [];
    const dbEntries = dbByTokenId.get(tokenId) ?? [];

    if (chainEntries.length > 0 && dbEntries.length === 0) {
      onChainOnly.push(...chainEntries);
    } else if (chainEntries.length === 0 && dbEntries.length > 0) {
      dbOnly.push(...dbEntries);
    } else {
      // Both exist — check denomination if possible
      countMatch += chainEntries.length;
    }
  }

  // Look up denominations for on-chain-only mints
  let onChainOnlyTotalDenom = 0;
  for (const mint of onChainOnly) {
    try {
      const denom = await respect.valueOfToken(mint.tokenId);
      mint.denomination = Number(denom);
      onChainOnlyTotalDenom += mint.denomination;
    } catch {
      mint.denomination = undefined;
    }
  }

  // Calculate totals
  const dbActiveDenom = dbAwards
    .filter(a => !a.burned)
    .reduce((sum, a) => sum + a.denomination, 0);
  const chainTotalDenom = chainMints.reduce((sum, m) => sum + (m.denomination ?? 0), 0);

  // Also look up on-chain totalRespect
  let onChainTotalRespect: bigint | undefined;
  try {
    onChainTotalRespect = await respect.totalRespect();
  } catch { }

  // Report
  console.log(`\n--- Results ---`);
  console.log(`On-chain totalRespect(): ${onChainTotalRespect !== undefined ? onChainTotalRespect.toString() : "N/A"}`);
  console.log(`DB active awards denomination sum: ${dbActiveDenom}`);
  if (onChainTotalRespect !== undefined) {
    const diff = Number(onChainTotalRespect) - dbActiveDenom;
    if (diff !== 0) {
      console.log(`  ⚠ MISMATCH: on-chain totalRespect - DB active sum = ${diff}`);
    } else {
      console.log(`  ✓ Totals match`);
    }
  }

  console.log(`\nMatched token IDs: ${countMatch}`);

  if (onChainOnly.length > 0) {
    console.log(`\n⚠ ON-CHAIN MINTS NOT IN DB (${onChainOnly.length}):`);
    console.log(`  Total denomination of missing awards: ${onChainOnlyTotalDenom}`);

    // Group by period for easier analysis
    const byPeriod = new Map<number, ChainMintEvent[]>();
    for (const m of onChainOnly) {
      const { periodNumber } = unpackTokenIdSimple(m.tokenId);
      if (!byPeriod.has(periodNumber)) byPeriod.set(periodNumber, []);
      byPeriod.get(periodNumber)!.push(m);
    }

    const sortedPeriods = [...byPeriod.keys()].sort((a, b) => a - b);
    for (const period of sortedPeriods) {
      const mints = byPeriod.get(period)!;
      const periodDenom = mints.reduce((s, m) => s + (m.denomination ?? 0), 0);
      console.log(`\n  Period ${period} (${mints.length} mints, total denom: ${periodDenom}):`);
      for (const m of mints) {
        const { owner, mintType } = unpackTokenIdSimple(m.tokenId);
        console.log(`    tokenId: ${m.tokenId}`);
        console.log(`      recipient: ${owner}, denomination: ${m.denomination ?? "?"}, mintType: ${mintType}`);
        console.log(`      tx: ${m.txHash} (block ${m.blockNumber})`);
      }
    }
  } else {
    console.log(`\n✓ All on-chain mints are present in DB`);
  }

  if (dbOnly.length > 0) {
    console.log(`\n⚠ DB AWARDS NOT ON-CHAIN (${dbOnly.length}):`);
    for (const a of dbOnly) {
      console.log(`    tokenId: ${a.tokenId}`);
      console.log(`      recipient: ${a.recipient}, denomination: ${a.denomination}, period: ${a.periodNumber}, mintType: ${a.mintType}, burned: ${a.burned}`);
      if (a.mintTxHash) console.log(`      mintTxHash: ${a.mintTxHash}`);
    }
  } else {
    console.log(`✓ All DB awards have corresponding on-chain events`);
  }
}
