// FORK=1 npx hardhat test test/fork.test.js - runs against a fork of Robinhood Chain mainnet (read-only, nothing is sent)
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ID = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", REP = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const NVDA_POOL = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

(process.env.FORK ? describe : describe.skip)("fork: real ERC-8004 registries + real NVDA/USDG pool", function () {
  this.timeout(300000);
  before(async () => {
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: "https://rpc.mainnet.chain.robinhood.com" } }] });
  });
  it("registers, commits, reveals, and lands feedback in the canonical reputation registry", async () => {
    // the default Hardhat accounts have code on this chain (ERC-721 safe-mint then rejects them), so use fresh keys
    const me = ethers.Wallet.createRandom().connect(ethers.provider), treasury = ethers.Wallet.createRandom();
    await network.provider.send("hardhat_setBalance", [me.address, "0x56BC75E2D63100000"]);
    const idr = new ethers.Contract(ID, ["function register() returns (uint256)", "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)", "function ownerOf(uint256) view returns (address)"], me);
    const rep = new ethers.Contract(REP, ["function getLastIndex(uint256,address) view returns (uint64)", "function readFeedback(uint256,address,uint64) view returns (int128,uint8,string,string,bool)"], me);
    const tok = await (await ethers.getContractFactory("MockToken", me)).deploy();
    const book = await (await ethers.getContractFactory("SignalBook", me)).deploy(ID, REP, tok, treasury.address, 0);
    const invert = NVDA.toLowerCase() > USDG.toLowerCase();   // NVDA is token1 when its address sorts higher
    await book.setAsset(0, NVDA_POOL, invert, true, "NVDA");
    const rc = await (await idr["register()"]()).wait();
    const agentId = rc.logs.map((l) => { try { return idr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Registered").args.agentId;
    expect(await idr.ownerOf(agentId)).to.equal(me.address);
    await book.enroll(agentId);
    const h = await book.hashSignal(agentId, 0, 1, 900, ethers.id("fork"));
    await book.commit(agentId, h);
    await time.increase(900 + 300 + 5);
    const keeper = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.send("hardhat_setBalance", [keeper.address, "0x56BC75E2D63100000"]);
    await expect(book.connect(keeper).reveal(0, 0, 1, 900, ethers.id("fork"))).to.emit(book, "Settled");
    const g = await book.signals(0);
    console.log("      agent", agentId.toString(), "score bps", g.scoreBps.toString());
    expect(g.status).to.equal(1);
    const idx = await rep.getLastIndex(agentId, await book.getAddress());
    expect(idx).to.be.greaterThan(0n);
    const f = await rep.readFeedback(agentId, await book.getAddress(), idx);
    expect(f[2]).to.equal("prysm/alpha"); expect(f[3]).to.equal("NVDA"); expect(f[1]).to.equal(2);
  });
});
