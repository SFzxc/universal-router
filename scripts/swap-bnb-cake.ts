import { ethers } from 'ethers';
import { parseUnits, solidityPacked, AbiCoder, MaxUint256 } from 'ethers';
import 'dotenv/config';

const RPC_URL = 'https://bsc-dataseed.bnbchain.org';
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const WALLET_ADDRESS = '0x2C626A2362860b100baFe9bBE54E39234c540010';

const CAKE_ADDRESS = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const UNIVERSAL_ROUTER_ADDRESS = '0x1A0A18AC4BECDDbd6389559687d1A73d8927E416';
const FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const QUOTER_ADDRESS = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

// ABI
const ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable'
];

const QUOTER_ABI = [
  'function quoteExactInput(bytes memory path, uint256 amountIn) external view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

// Khởi tạo provider và wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not defined in .env file');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Khởi tạo contract
const routerContract = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, ROUTER_ABI, wallet);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const quoterContract = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

// Các mức phí có thể có
const FEES = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

// Hàm mã hóa path
function encodePath(tokenIn: string, fee: number, tokenOut: string): string {
  return solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

// Hàm mã hóa calldata cho V3_SWAP_EXACT_IN
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
      false // false vì chúng ta không dùng Permit2 cho native BNB
    ]
  );
}

// Ước lượng minCakeOut bằng quoter
async function estimateMinCakeOut(amountToSell: string, path: string): Promise<string> {
  const amountIn = parseUnits(amountToSell, 18);
  const iface = new ethers.Interface(QUOTER_ABI);
  const encodedData = iface.encodeFunctionData('quoteExactInput', [path, amountIn]);
  const result = await provider.call({
      to: QUOTER_ADDRESS,
      data: encodedData,
  });
  const decodedResult = iface.decodeFunctionResult('quoteExactInput', result);
  const amountOut = decodedResult[0];
  const amountOutWithSlippage = (amountOut * 90n) / 100n; // Giảm 10% để tránh slippage
  return ethers.formatUnits(amountOutWithSlippage, 18);
}

// Tìm pool fee
async function findPoolFee(): Promise<number> {
  for (const fee of FEES) {
    const pool = await factoryContract.getPool(WBNB_ADDRESS, CAKE_ADDRESS, fee);
    if (pool !== ethers.ZeroAddress) {
      console.log(`Found pool with fee: ${fee / 10000}%`);
      return fee;
    }
  }
  throw new Error('No pool found for WBNB/CAKE pair');
}

// Hàm swap BNB sang CAKE
async function buyCAKEWithBNB(amountToSell: string) {
  try {
    console.log('Starting BNB to CAKE swap...');
    console.log('Amount to sell:', amountToSell, 'BNB');

    // Kiểm tra số dư BNB
    const bnbBalance = await provider.getBalance(WALLET_ADDRESS);
    console.log('BNB balance:', ethers.formatEther(bnbBalance));
    if (bnbBalance < parseUnits(amountToSell, 18)) throw new Error('Insufficient BNB balance');

    // Tìm pool và phí
    const fee = await findPoolFee();
    const path = encodePath(WBNB_ADDRESS, fee, CAKE_ADDRESS);

    // Ước lượng minCakeOut
    const minCakeOut = await estimateMinCakeOut(amountToSell, path);
    console.log('Estimated min CAKE out:', minCakeOut);

    // Mã lệnh: WRAP_ETH (0x0b) + V3_SWAP_EXACT_IN (0x00)
    const commands = '0x0b00';

    // Wrap BNB thành WBNB
    const wrapEthCalldata = AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [UNIVERSAL_ROUTER_ADDRESS, parseUnits(amountToSell, 18)]
    );

    // Swap WBNB sang CAKE
    const v3Calldata = encodeV3SwapExactIn(amountToSell, minCakeOut, path, WALLET_ADDRESS);

    const inputs = [wrapEthCalldata, v3Calldata];

    const currentBlock = await provider.getBlock('latest');
    if (!currentBlock) throw new Error('Failed to get latest block');
    const deadline = currentBlock.timestamp + 3600;

    const estimateGas = await routerContract.execute.estimateGas(commands, inputs, deadline, {
      value: parseUnits(amountToSell, 18), // Gửi BNB native
      gasLimit: 3000000
    });
    console.log('Estimate gas:', estimateGas);

    const tx = await routerContract.execute(commands, inputs, deadline, {
        value: parseUnits(amountToSell, 18), // Gửi BNB native
        gasLimit: 3000000
    });
    console.log('Swap transaction hash:', tx.hash);
    const receipt = await tx.wait();
    console.log('Swap transaction confirmed:', receipt.transactionHash);
    // https://bscscan.com/tx/0xc8f5db9e8500bb00aa52abad79f578b22e5016de4753f9621ab6b71309878e3d
  } catch (error) {
    console.error('Swap failed:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
}

// Gọi hàm swap với 0.1 BNB
buyCAKEWithBNB('0.005').catch(console.error);