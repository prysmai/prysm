#!/bin/bash
# local chain with mock ERC-8004 registries and mock pools -> deploy -> server (with keeper) -> MCP end-to-end test -> season build.
# (The real registries and pools are exercised by contracts/test/fork.test.js.)
set -e
cd "$(dirname "$0")"; ROOT=$PWD; LOG=${LOG:-/tmp/prysm-e2e}; mkdir -p $LOG
# the subshells' children (hardhat node, server) must go too, so free the ports themselves
freeports() { for p in 8545 5610; do lsof -t -iTCP:$p -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; done; }
cleanup() { kill $NODE $SRV 2>/dev/null || true; freeports; }
freeports; sleep 1
trap cleanup EXIT
(cd contracts && npx hardhat node --port 8545 > $LOG/node.log 2>&1) & NODE=$!
for i in $(seq 1 60); do curl -s -m 2 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null && break; sleep 1; done
(cd contracts && npx hardhat run scripts/deploy-local.js --network localhost > $LOG/deploy.log 2>&1)
# keeper: a throwaway key funded on the fork only
KK=$(node -e 'console.log(require("./server/node_modules/ethers").Wallet.createRandom().privateKey)')
KA=$(node -e "console.log(new (require('./server/node_modules/ethers').Wallet)('$KK').address)")
curl -s -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hardhat_setBalance\",\"params\":[\"$KA\",\"0x56BC75E2D63100000\"]}" http://127.0.0.1:8545 >/dev/null
rm -f server/data/state-31337-* server/data/sealed-31337-*
(cd server && RPC=http://127.0.0.1:8545 DEPLOYMENT=../contracts/deployments/localhost.json PORT=5610 KEEPER_KEY=$KK KEEPER_INTERVAL=3 KEEPER_GRACE=0 SEASON_EPOCH=2026-01-05T00:00:00Z node server.mjs > $LOG/server.log 2>&1) & SRV=$!
for i in $(seq 1 30); do curl -s -m 2 localhost:5610/api/stats >/dev/null && break; sleep 1; done
(cd mcp && node test/e2e.mjs)
(cd agents && node test/committee-e2e.mjs)
(cd cli && node scripts/sync.mjs --check && node test/e2e.mjs)
# the e2e jumped the chain clock ~1.5h ahead, so the season is taken from chain time
NOW=$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' http://127.0.0.1:8545 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(parseInt(JSON.parse(s).result.timestamp,16)))')
SEASON=$(node -e "console.log(Math.floor(($NOW*1000-Date.parse('2026-01-05T00:00:00Z'))/(7*86400000)))")
(cd server && RPC=http://127.0.0.1:8545 DEPLOYMENT=../contracts/deployments/localhost.json SEASON_EPOCH=2026-01-05T00:00:00Z FORCE=1 node season.mjs build $SEASON 1000)
echo "--- server log"; tail -8 $LOG/server.log
[ -n "$KEEP" ] && { echo "KEEP set: chain + server stay up on :8545 / :5610 (ctrl-c to stop)"; wait $SRV; }
