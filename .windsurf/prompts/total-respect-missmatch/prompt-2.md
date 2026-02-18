# Total Respect Missmatch. Prompt 2

I have used the script on the relevant frapp. Results are saved [here](./resources/results.txt).

Here's the relevant transaction in the block explorer: https://explorer.optimism.io/tx/0x60aad2cb3e412feabf241c5100c5bcb4870ac4344c0c7353e79172321f45ba52?tab=logs

Now I would use the ornode-sync command to sync that block so that it processes the missing events. But two problems:

1. For some reason the proposal, execution of which has triggered these events has status updated, with execution tx hash and everything. This means there will be a problem in sync script, because it tries to retrieve unexecuted proposal by id (line 875 in [ornode.ts](../../../ordao/services/ornode/src/ornode.ts));
2. I'm not completely sure the script is ok to use when the events being synced are not the latest ones (when there are newer events which have already been processed).