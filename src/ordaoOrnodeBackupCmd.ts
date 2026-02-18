import { Command } from "commander";
import { exec } from "./exec.js";

export const ordaoOrnodeBackupCmd = new Command("ornode-backup")
  .showHelpAfterError()
  .action(() => {
    console.log("Backing up ornode db");
    backup();
  });

function backup() {
  const backupDir = process.env.BACKUP_DIR;
  const uri = process.env.MONGO_DUMP_URI;

  const outFile = `${backupDir}/${Date.now()}.bson`

  const cmd = `mongodump --archive=${outFile} ${uri}`

  exec(cmd)
}
