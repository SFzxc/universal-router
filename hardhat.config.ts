import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    polygon: {
      url: "https://polygon.llamarpc.com",
      accounts: [`0x${process.env.MAINNET_PRIVATE_KEY}`],
      chainId: 137,
    },
  },
};

export default config;
