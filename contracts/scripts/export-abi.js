// node scripts/export-abi.js (after `npx hardhat compile`): writes ../shared/abi.json and ../mcp/abi.json
const fs = require("fs"), path = require("path");
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${n}.sol/${n}.json`))).abi;
const old = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/abi.json")));
const out = { ...old, SignalBook: art("SignalBook"), League: art("League"), Subscriptions: art("Subscriptions") };   // external registries/ERC20 kept
for (const f of ["../../shared/abi.json", "../../mcp/abi.json"]) fs.writeFileSync(path.join(__dirname, f), JSON.stringify(out));
console.log("abi exported:", Object.keys(out).join(", "));
