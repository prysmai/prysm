// sorted-pair Merkle tree over League.leaf(season, agentId, amount) = keccak(keccak(abi.encode(...))), as OpenZeppelin verifies
import { ethers } from "ethers";
const coder = ethers.AbiCoder.defaultAbiCoder();
export const leaf = (season, agentId, amount) =>
  ethers.keccak256(ethers.keccak256(coder.encode(["uint256", "uint256", "uint256"], [season, agentId, amount])));
const pair = (a, b) => ethers.keccak256(ethers.concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
export function build(leaves) {
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const l = layers.at(-1), n = [];
    for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? pair(l[i], l[i + 1]) : l[i]);
    layers.push(n);
  }
  const proof = (i) => { const p = []; for (const l of layers.slice(0, -1)) { const j = i ^ 1; if (j < l.length) p.push(l[j]); i >>= 1; } return p; };
  return { root: layers.at(-1)[0] || ethers.ZeroHash, proof };
}
