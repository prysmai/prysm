// npx hardhat run scripts/deploy.js --network <rhMainnet|localhost>
// env: TOKEN (the PRYSM token from pools.trade; on localhost a mock is deployed when unset), TREASURY, ENROLL_FEE (whole tokens),
//      SUB_FEE_BPS (default 1000), DEPLOYER_KEY (only for rhMainnet; never committed)
const fs = require("fs"), path = require("path");
const { ethers, network } = require("hardhat");
const ID = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", REP = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

async function main() {
  const [me] = await ethers.getSigners();
  const assets = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/assets.json"))).assets;
  let token = process.env.TOKEN;
  if (!token) {
    if (network.name === "rhMainnet") throw new Error("set TOKEN to the PRYSM token address before a mainnet deploy");
    token = await (await (await ethers.getContractFactory("MockToken")).deploy()).getAddress();
    console.log("mock token", token);
  }
  const treasury = process.env.TREASURY || me.address;
  const fee = ethers.parseEther(process.env.ENROLL_FEE || "0");
  const book = await (await ethers.getContractFactory("SignalBook")).deploy(ID, REP, token, treasury, fee);
  const league = await (await ethers.getContractFactory("League")).deploy(ID, token);
  const subs = await (await ethers.getContractFactory("Subscriptions")).deploy(ID, token, treasury, +(process.env.SUB_FEE_BPS || 1000));
  await Promise.all([book.waitForDeployment(), league.waitForDeployment(), subs.waitForDeployment()]);
  for (const a of assets) await (await book.setAsset(a.id, a.pool, a.invert, true, a.sym)).wait();
  const block = await ethers.provider.getBlockNumber();
  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), deployedAt: new Date().toISOString(), block,
    deployer: me.address, treasury, token, identity: ID, reputation: REP,
    signalBook: await book.getAddress(), league: await league.getAddress(), subscriptions: await subs.getAddress() };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(out);
}
main().catch((e) => { console.error(e); process.exit(1); });
