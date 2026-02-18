import { Command } from "commander";
import { ordaoContractsCmd } from "./ordaoContractsCmd.js";
import { ordaoOrnodeCmd } from "./ordaoOrnodeCmd.js";
import { ordaoOrnodeBackupCmd } from "./ordaoOrnodeBackupCmd.js";
import { ordaoOrclientDocsCmd } from "./ordaoOrclientDocsCmd.js";
import { ordaoGuiCmd } from "./ordaoGuiCmd.js";
import { ordaoOrnodeSyncCmd } from "./ordaoOrnodeSyncCmd.js";
import { ordaoRSplitsCmd } from "./ordaoRSplit.js";
import { ordaoParentDeployCmd } from "./ordaoParentDeployCmd.js";
import { ordaoCheckAwardsCmd } from "./ordaoCheckAwardsCmd.js";

export const ordaoCommands: Command[] = [
  ordaoContractsCmd,
  ordaoOrnodeCmd,
  ordaoOrnodeBackupCmd,
  ordaoOrclientDocsCmd,
  ordaoGuiCmd,
  ordaoOrnodeSyncCmd,
  ordaoRSplitsCmd,
  ordaoParentDeployCmd,
  ordaoCheckAwardsCmd,
];
