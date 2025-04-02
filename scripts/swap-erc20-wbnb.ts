import { ethers } from 'ethers';
import { parseUnits, solidityPacked, AbiCoder, MaxUint256 } from 'ethers';
import 'dotenv/config';
const MaxUint160 = BigInt('0x' + 'F'.repeat(40)); // 160 bits of 1s

const RPC_URL = 'https://bsc-dataseed.bnbchain.org';
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const WALLET_ADDRESS = '0x2C626A2362860b100baFe9bBE54E39234c540010'; // Địa chỉ ví của bạn

const CAKE_ADDRESS = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'; // CAKE trên BSC
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'; // WBNB trên BSC
const UNIVERSAL_ROUTER_ADDRESS = '0x1A0A18AC4BECDDbd6389559687d1A73d8927E416'; // UniversalRouter của Pancakeswap
const FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'; // Pancakeswap V3 Factory
const PERMIT2_ADDRESS = '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768'; // Permit2 contract
const QUOTER_ADDRESS = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'; // Quoter V2 của Pancakeswap

// ABI
const ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable'
];

const CAKE_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)'
];

const WBNB_ABI = [
  'function withdraw(uint256 amount) external',
  'function balanceOf(address account) external view returns (uint256)'
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration)'
];

const QUOTER_ABI = [
  'function quoteExactInput(bytes memory path, uint256 amountIn) external view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'
];

// Khởi tạo provider và wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not defined in .env file');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Khởi tạo contract
const routerContract = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, ROUTER_ABI, wallet);
const cakeContract = new ethers.Contract(CAKE_ADDRESS, CAKE_ABI, wallet);
const wbnbContract = new ethers.Contract(WBNB_ADDRESS, WBNB_ABI, wallet);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
const quoterContract = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);

// Các mức phí có thể có
const FEES = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

// Hàm mã hóa path
function encodePath(tokenIn: string, fee: number, tokenOut: string): string {
  return solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

// Hàm mã hóa calldata cho V3_SWAP_EXACT_IN
// Referece: https://docs.uniswap.org/contracts/universal-router/technical-reference
// Params:
// address The recipient of the output of the trade
// uint256 The amount of input tokens for the trade
// uint256 The minimum amount of output tokens the user wants
// bytes The UniswapV3 encoded path to trade along
// bool A flag for whether the input tokens should come from the msg.sender (through Permit2) or whether the funds are already in the UniversalRouter
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

// Ước lượng minBnbOut bằng quoter
async function estimateMinBnbOut(amountToSell: string, path: string): Promise<string> {
  const amountIn = parseUnits(amountToSell, 18);
  const iface = new ethers.Interface(QUOTER_ABI);
  const encodedData = iface.encodeFunctionData('quoteExactInput', [path, amountIn]);
  const result = await provider.call({
      to: QUOTER_ADDRESS,
      data: encodedData,
  });
  const decodedResult = iface.decodeFunctionResult('quoteExactInput', result);
  const amountOut = decodedResult[0]; // amountOut là giá trị đầu tiên
  const amountOutWithSlippage = (amountOut * 90n) / 100n; // Giảm 10% để tránh slippage
  return ethers.formatUnits(amountOutWithSlippage, 18);
}

// Phê duyệt CAKE cho Permit2
async function approveCakeForPermit2() {
  const allowance = await cakeContract.allowance(WALLET_ADDRESS, PERMIT2_ADDRESS);
  console.log('Current CAKE allowance for Permit2:', allowance.toString());

  if (allowance >= MaxUint256) {
    console.log('Already approved CAKE for Permit2 with MaxUint256');
    return;
  }

  const tx = await cakeContract.approve(PERMIT2_ADDRESS, MaxUint160 - 1n);
  const receipt = await tx.wait(1);
  console.log('CAKE approved for Permit2 with MaxUint256:', receipt.transactionHash);
}

// Phê duyệt Permit2 cho Universal Router
async function checkAndApprovePermit2Allowance(amountToSell: string) {
  const [currentAmount, currentExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
  console.log('Current Permit2 allowance for Universal Router:', currentAmount.toString());
  console.log('Current expiration:', currentExpiration.toString());
  console.log('Current timestamp:', Math.floor(Date.now() / 1000));

  const requiredAmount = parseUnits(amountToSell, 18);
  if (currentAmount >= requiredAmount && currentExpiration > Math.floor(Date.now() / 1000)) {
    console.log('Already approved Permit2 for Universal Router with sufficient amount and not expired');
    return;
  }

  const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // 1 year
  console.log('Setting new expiration to:', expiration);

  const tx = await permit2Contract.approve(CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS, requiredAmount, expiration);
  const receipt = await tx.wait(1);
  console.log('Permit2 approved for Universal Router:', receipt.transactionHash);

  const [newAmount, newExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
  console.log('New Permit2 allowance after confirmation:', newAmount.toString());
  console.log('New expiration after confirmation:', newExpiration.toString());
  if (newAmount < requiredAmount || newExpiration <= Math.floor(Date.now() / 1000)) {
    throw new Error('Permit2 approval failed or expired immediately');
  }
}

// Tìm pool fee
async function findPoolFee(): Promise<number> {
  for (const fee of FEES) {
    const pool = await factoryContract.getPool(CAKE_ADDRESS, WBNB_ADDRESS, fee);
    if (pool !== ethers.ZeroAddress) {
      console.log(`Found pool with fee: ${fee / 10000}%`);
      return fee;
    }
  }
  throw new Error('No pool found for CAKE/WBNB pair');
}

// Hàm swap CAKE sang BNB
async function sellCakeToBnb(amountToSell: string) {
  try {
    console.log('Starting CAKE to BNB swap...');
    console.log('Amount to sell:', amountToSell, 'CAKE');

    // Kiểm tra số dư
    const cakeBalance = await cakeContract.balanceOf(WALLET_ADDRESS);
    console.log('CAKE balance:', ethers.formatUnits(cakeBalance, 18));
    if (cakeBalance < parseUnits(amountToSell, 18)) throw new Error('Insufficient CAKE balance');

    const bnbBalance = await provider.getBalance(WALLET_ADDRESS);
    console.log('BNB balance:', ethers.formatEther(bnbBalance));
    if (bnbBalance < ethers.parseEther('0.01')) throw new Error('Insufficient BNB for gas');

    // Phê duyệt
    await approveCakeForPermit2();
    await checkAndApprovePermit2Allowance(amountToSell);

    // Kiểm tra lại allowance trước khi swap
    const [finalAmount, finalExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, CAKE_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
    console.log('Final Permit2 allowance before swap:', finalAmount.toString());
    console.log('Final expiration before swap:', finalExpiration.toString());
    if (finalAmount < parseUnits(amountToSell, 18) || finalExpiration <= Math.floor(Date.now() / 1000)) {
      throw new Error('Insufficient allowance or expired before swap');
    }

    // Tìm pool và phí
    const fee = await findPoolFee();
    const path = encodePath(CAKE_ADDRESS, fee, WBNB_ADDRESS);

    // Ước lượng minBnbOut
    const minBnbOut = await estimateMinBnbOut(amountToSell, path);
    console.log('Estimated min BNB out:', minBnbOut);

    // Swap CAKE sang WBNB, nhưng người nhận là UniversalRouter để unwrap WBNB
    const v3Calldata = encodeV3SwapExactIn(amountToSell, minBnbOut, path, UNIVERSAL_ROUTER_ADDRESS); // Note: Nếu ko có 0x0c thì phải chuyển về WALLET_ADDRESS

    // Referece: https://docs.uniswap.org/contracts/universal-router/technical-reference
    // address The recipient of the ETH
    // uint256 The minimum required ETH to receive from the unwrapping
    const unwrapCalldata = AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [WALLET_ADDRESS, parseUnits(minBnbOut, 18)]
    );
    const commands = '0x000c'; // V3_SWAP_EXACT_IN (0x00) + UNWRAP_WETH (0x0c)
    const inputs = [v3Calldata, unwrapCalldata];

    const currentBlock = await provider.getBlock('latest');
    if (!currentBlock) throw new Error('Failed to get latest block');
    const deadline = currentBlock.timestamp + 3600;

    const gasEstimate = await routerContract.execute.estimateGas(commands, inputs, deadline);
    console.log('Estimated gas:', gasEstimate.toString());

    const tx = await routerContract.execute(commands, inputs, deadline, {
      gasLimit: gasEstimate * 120n / 100n,
    });

    console.log('Swap transaction hash:', tx.hash);
    const receipt = await tx.wait();
    console.log('Swap transaction confirmed:', receipt.transactionHash);

    // // Unwrap WBNB thành BNB
    // const wbnbBalance = await wbnbContract.balanceOf(WALLET_ADDRESS);
    // console.log('WBNB balance after swap:', ethers.formatUnits(wbnbBalance, 18));
    // if (wbnbBalance > 0) {
    //   const unwrapTx = await wbnbContract.withdraw(wbnbBalance);
    //   const unwrapReceipt = await unwrapTx.wait();
    //   console.log('Unwrap transaction confirmed:', unwrapReceipt.transactionHash);
    // }

    // const finalBnbBalance = await provider.getBalance(WALLET_ADDRESS);
    // console.log('Final BNB balance:', ethers.formatEther(finalBnbBalance));
  } catch (error) {
    console.error('Swap failed:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
}

// Gọi hàm swap
sellCakeToBnb('0.1').catch(console.error);