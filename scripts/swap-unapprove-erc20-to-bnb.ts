import { ethers } from 'ethers';
import { parseUnits, solidityPacked, AbiCoder, MaxUint256 } from 'ethers';
import 'dotenv/config';
const MaxUint160 = BigInt('0x' + 'F'.repeat(40)); // 160 bits of 1s

const RPC_URL = 'https://bsc-dataseed.bnbchain.org';
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;
const WALLET_ADDRESS = '0x2C626A2362860b100baFe9bBE54E39234c540010';

const TST_ADDRESS = '0x86Bb94DdD16Efc8bc58e6b056e8df71D9e666429';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const UNIVERSAL_ROUTER_ADDRESS = '0x1A0A18AC4BECDDbd6389559687d1A73d8927E416';
const FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const PERMIT2_ADDRESS = '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768';
const QUOTER_ADDRESS = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

// ABI
const ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable'
];

const TST_ABI = [
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
  'function permit(address owner, tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) permitSingle, bytes signature) external',
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
const tstContract = new ethers.Contract(TST_ADDRESS, TST_ABI, wallet);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);

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
      true
    ]
  );
}

// Hàm tạo PermitSingle
function createPermitSingle(
  token: string,
  amount: bigint,
  expiration: number,
  nonce: number,
  spender: string,
  sigDeadline: number
): any {
  return {
    details: {
      token,
      amount,
      expiration,
      nonce
    },
    spender,
    sigDeadline
  };
}

// Hàm tạo chữ ký cho PermitSingle
async function signPermitSingle(permitSingle: any): Promise<string> {
  const domain = {
    name: 'Permit2',
    chainId: 56, // BSC chainId
    verifyingContract: PERMIT2_ADDRESS
  };

  const types = {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' }
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' }
    ]
  };

  const signature = await wallet.signTypedData(domain, types, permitSingle);
  return signature;
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
  const amountOut = decodedResult[0];
  const amountOutWithSlippage = (amountOut * 1n) / 1000n; // Giảm 0.1% để tránh slippage
  return ethers.formatUnits(amountOutWithSlippage, 18);
}

// Tìm pool fee
async function findPoolFee(): Promise<number> {
  for (const fee of FEES) {
    const pool = await factoryContract.getPool(TST_ADDRESS, WBNB_ADDRESS, fee);
    if (pool !== ethers.ZeroAddress) {
      console.log(`Found pool with fee: ${fee / 10000}%`);
      return fee;
    }
  }
  throw new Error('No pool found for TST/WBNB pair');
}

// Hàm phê duyệt TST cho Permit2
async function approveTSTForPermit2() {
  const allowance = await tstContract.allowance(WALLET_ADDRESS, PERMIT2_ADDRESS);
  console.log('Current TST allowance for Permit2:', allowance.toString());

  if (allowance >= MaxUint160 - 1n) {
    console.log('Already approved TST for Permit2 with MaxUint256');
    return;
  }

  const tx = await tstContract.approve(PERMIT2_ADDRESS, MaxUint256);
  const receipt = await tx.wait(1);
  console.log('TST approved for Permit2 with MaxUint256:', receipt.transactionHash);
}

// Hàm swap TST sang BNB
async function sellTSTToBnb(amountToSell: string) {
  try {
    console.log('Starting TST to BNB swap...');
    console.log('Amount to sell:', amountToSell, 'TST');

    // Kiểm tra số dư
    const tstBalance = await tstContract.balanceOf(WALLET_ADDRESS);
    console.log('TST balance:', ethers.formatUnits(tstBalance, 18));
    if (tstBalance < parseUnits(amountToSell, 18)) throw new Error('Insufficient TST balance');

    const bnbBalance = await provider.getBalance(WALLET_ADDRESS);
    console.log('BNB balance:', ethers.formatEther(bnbBalance));
    if (bnbBalance < ethers.parseEther('0.01')) throw new Error('Insufficient BNB for gas');

    // Lấy deadline
    const currentBlock = await provider.getBlock('latest');
    if (!currentBlock) throw new Error('Failed to get latest block');
    const deadline = currentBlock.timestamp + 3600;

    // Kiểm tra allowance của Permit2 cho UniversalRouter
    const [currentAmount, currentExpiration] = await permit2Contract.allowance(WALLET_ADDRESS, TST_ADDRESS, UNIVERSAL_ROUTER_ADDRESS);
    console.log('Current Permit2 allowance:', currentAmount.toString());
    console.log('Current expiration:', currentExpiration.toString());

    const requiredAmount = parseUnits(amountToSell, 18);
    const currentTimestamp = Math.floor(Date.now() / 1000);

    let commands = '0x00'; // V3_SWAP_EXACT_IN
    let inputs = [];

    // Nếu allowance không đủ hoặc đã hết hạn, thêm PERMIT2_PERMIT
    if (currentAmount < requiredAmount || currentExpiration <= currentTimestamp) {
      console.log('Adding PERMIT2_PERMIT command...');
      commands = '0x0a00'; // PERMIT2_PERMIT + V3_SWAP_EXACT_IN

      // Tạo PermitSingle
      const deadline = currentBlock.timestamp + 3600;

      const permitSingle = createPermitSingle(
        TST_ADDRESS,
        parseUnits(amountToSell, 18),
        deadline,
        0, // nonce
        UNIVERSAL_ROUTER_ADDRESS,
        deadline
      );

      // Tạo chữ ký
      const signature = await signPermitSingle(permitSingle);

      // Encode PermitSingle và signature
      const permitCalldata = AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,uint160,uint48,uint48)', 'address', 'uint256', 'bytes'],
        [
          [
            permitSingle.details.token,
            permitSingle.details.amount,
            permitSingle.details.expiration,
            permitSingle.details.nonce
          ],
          permitSingle.spender,
          permitSingle.sigDeadline,
          signature
        ]
      );

      inputs.push(permitCalldata);
    }

    // Tìm pool và phí
    const fee = await findPoolFee();
    const path = encodePath(TST_ADDRESS, fee, WBNB_ADDRESS);

    // Ước lượng minBnbOut
    const minBnbOut = await estimateMinBnbOut(amountToSell, path);
    console.log('Estimated min BNB out:', minBnbOut);

    // Swap TST sang WBNB
    const v3Calldata = encodeV3SwapExactIn(amountToSell, minBnbOut, path, UNIVERSAL_ROUTER_ADDRESS);
    inputs.push(v3Calldata);

    // Thêm UNWRAP_WETH
    commands += '0c';
    const unwrapCalldata = AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [WALLET_ADDRESS, parseUnits(minBnbOut, 18)]
    );
    inputs.push(unwrapCalldata);

    console.log('Commands:', commands);
    console.log('Number of inputs:', inputs.length);

    const estimateGas = await routerContract.execute.estimateGas(commands, inputs, deadline, {
      gasLimit: 3000000
    });
    console.log('Estimate gas:', estimateGas);

    const tx = await routerContract.execute(commands, inputs, deadline, {
      gasLimit: 3000000
    });
    console.log('Swap transaction hash:', tx.hash);
    const receipt = await tx.wait();
    console.log('Swap transaction confirmed:', receipt.transactionHash);
  } catch (error) {
    console.error('Swap failed:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
}

sellTSTToBnb('2').catch(console.error);