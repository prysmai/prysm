// npx hardhat run scripts/deploy-local.js --network localhost - plain local chain with mock ERC-8004 registries, token and
// pools (prices driven by MockPool.setPath) for end-to-end tests of the server, MCP and site
const fs = require("fs"), path = require("path");
const { ethers, network } = require("hardhat");
async function main() {
  const [me] = await ethers.getSigners();
  const f = (n) => ethers.getContractFactory(n);
  const tok = await (await f("MockToken")).deploy(), idr = await (await f("MockIdentity")).deploy(), rep = await (await f("MockReputation")).deploy();
  const book = await (await f("SignalBook")).deploy(idr, rep, tok, me.address, ethers.parseEther("10"));
  const league = await (await f("League")).deploy(idr, tok), subs = await (await f("Subscriptions")).deploy(idr, tok, me.address, 1000);
  const assets = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/assets.json"))).assets, pools = {};
  for (const a of assets) { const p = await (await f("MockPool")).deploy(); await (await p.setPath(0, 0)).wait(); pools[a.sym] = await p.getAddress(); await (await book.setAsset(a.id, p, a.invert, true, a.sym)).wait(); }
  const out = { network: network.name, chainId: 31337, deployedAt: new Date().toISOString(), block: await ethers.provider.getBlockNumber(), deployer: me.address, treasury: me.address,
    token: await tok.getAddress(), identity: await idr.getAddress(), reputation: await rep.getAddress(), signalBook: await book.getAddress(), league: await league.getAddress(),
    subscriptions: await subs.getAddress(), mockPools: pools };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "../deployments/localhost.json"), JSON.stringify(out, null, 2));
  console.log(out);
}
main().catch((e) => { console.error(e); process.exit(1); });
