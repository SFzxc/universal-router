import { ethers } from 'ethers';
import { parseUnits, solidityPacked, AbiCoder, MaxUint256 } from 'ethers';
import { AllowanceProvider, PERMIT2_ADDRESS as PERMIT2_ADDRESS_SDK, AllowanceTransfer, PermitSingle, MaxUint160 } from '@uniswap/permit2-sdk';
import 'dotenv/config';

const RPC_URL = 'https://bsc-dataseed.bnbchain.org';
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const WALLET_ADDRESS = '0x2C626A2362860b100baFe9bBE54E39234c540010'; // Địa chỉ ví của bạn

const CAKE_ADDRESS = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'; // CAKE trên BSC
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'; // WBNB trên BSC
const UNIVERSAL_ROUTER_ADDRESS = '0x1A0A18AC4BECDDbd6389559687d1A73d8927E416'; // UniversalRouter của Pancakeswap
const FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'; // Pancakeswap V3 Factory
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'; // Permit2 contract

const ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable'
];
const CAKE_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)'
];
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration)'
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not defined in .env file');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const routerContract = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, ROUTER_ABI, wallet);
const cakeContract = new ethers.Contract(CAKE_ADDRESS, CAKE_ABI, wallet);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);

// Các mức phí có thể có
const FEES = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

function encodePath(tokenIn: string, fee: number, tokenOut: string): string {
  return solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

function encodeV3SwapExactIn(
  amountIn: string,
  amountOutMin: string,
  path: string,
  to: string
): string {
  return AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256', 'bytes', 'bool'],
    [
      to,
      parseUnits(amountIn, 18),
      parseUnits(amountOutMin, 18),
      path,
      true
    ]
  );
}

async function checkAndApprovePermit2Allowance() {
  // Check current allowance for UniversalRouter
  const [currentAmount, currentExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
  console.log('Current Permit2 allowance:', currentAmount.toString());
  console.log('Current expiration:', currentExpiration.toString());
  console.log('Current timestamp:', Math.floor(Date.now() / 1000));

  // If already approved with sufficient amount and not expired, skip
  if (currentAmount >= MaxUint160 && currentExpiration > Math.floor(Date.now() / 1000)) {
    console.log('Already approved with MaxUint160 and not expired');
    return;
  }

  // Approve Permit2 for UniversalRouter with MaxUint160
  const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // 1 year
  console.log('Setting new expiration to:', expiration);

  const tx = await permit2Contract.approve(CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS, parseUnits('1000', 18), expiration);
  await tx.wait();
  console.log('Permit2 approved for UniversalRouter');

  // Verify the approval
  const [newAmount, newExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
  console.log('New Permit2 allowance:', newAmount.toString());
  console.log('New expiration:', newExpiration.toString());
}

// Approve CAKE for Permit2 with MaxUint256
async function approveCakeForPermit2() {
  // Check current allowance
  const allowance = await cakeContract.allowance(WALLET_ADDRESS, PERMIT2_ADDRESS);
  console.log('Current allowance:', allowance.toString());

  // If already approved with MaxUint256, skip
  if (allowance >= MaxUint256) {
    console.log('Already approved with MaxUint256');
    return;
  }

  // Approve CAKE for Permit2 with MaxUint256
  const tx = await cakeContract.approve(PERMIT2_ADDRESS, MaxUint256);
  await tx.wait();
  console.log('CAKE approved for Permit2 with MaxUint256');
}

async function findPoolFee(): Promise<number> {
  for (const fee of FEES) {
    const pool = await factoryContract.getPool(CAKE_ADDRESS, WBNB_ADDRESS, fee);
    if (pool !== ethers.ZeroAddress) {
      console.log(`Found pool with fee: ${fee/10000}%`);
      return fee;
    }
  }
  throw new Error('No pool found for CAKE/WBNB pair');
}

async function sellCakeToBnb(amountToSell: string, minBnbOut: string) {
  try {
    console.log('Start sell CAKE to BNB');
    console.log('Amount to sell:', amountToSell);
    console.log('Min BNB out:', minBnbOut);

    // Approve CAKE for Permit2 first
    await approveCakeForPermit2();
    console.log('CAKE approval for Permit2 completed');

    // Then check and approve Permit2 allowance for UniversalRouter
    await checkAndApprovePermit2Allowance();
    console.log('Permit2 allowance check completed');

    // Tìm pool với phí phù hợp
    const FEE = await findPoolFee();
    console.log(`Create tx with fee: ${FEE}`);
    const path = encodePath(CAKE_ADDRESS, FEE, WBNB_ADDRESS);
    console.log('Encoded path:', path);

    // Commands: 0x00 (V3_SWAP_EXACT_IN) + 0x0c (UNWRAP_WETH)
    const commands = '0x000c';
    const v3Calldata = encodeV3SwapExactIn(amountToSell, minBnbOut, path, WALLET_ADDRESS);
    const unwrapCalldata = AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [WALLET_ADDRESS, parseUnits(minBnbOut, 18)]
    );

    console.log('V3 calldata:', v3Calldata);
    console.log('Unwrap calldata:', unwrapCalldata);

    // Thời hạn giao dịch (1 giờ từ thời điểm hiện tại của blockchain)
    const currentBlock = await provider.getBlock('latest');
    if (!currentBlock) throw new Error('Failed to get latest block');
    const deadline = currentBlock.timestamp + 60 * 60; // Cộng thêm 1 giờ (3600 giây)
    const inputs = [v3Calldata, unwrapCalldata];

    console.log('Deadline:', deadline);
    console.log('Current block timestamp:', currentBlock.timestamp);

    const estimateGas = await routerContract.execute.estimateGas(commands, inputs, deadline);
    console.log('Estimate gas:', estimateGas);

    const tx = await routerContract.execute(commands, inputs, deadline, {
      gasLimit: 3000000
    });

    console.log('Transaction sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('Transaction confirmed:', receipt.transactionHash);
  } catch (error) {
    console.error('Error during swap:', error);
    // Log more details about the error
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
  }
}

sellCakeToBnb('0.3', '0.000000001');