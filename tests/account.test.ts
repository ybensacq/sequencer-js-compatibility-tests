import {
  Account,
  Contract,
  DeclareDeployUDCResponse,
  DeployTransactionReceiptResponse,
  TransactionType,
  cairo,
  ec,
  hash,
  num,
  parseUDCEvent,
  shortString,
  stark, RpcProvider,
} from 'starknet';
import {
  compiledErc20,
  compiledHelloSierra,
  compiledHelloSierraCasm,
  compiledNamingContract,
  compiledOpenZeppelinAccount,
  compiledStarknetId,
  describeIfDevnet,
  describeIfDevnetSequencer,
  erc20ClassHash,
} from './fixtures';
import { initializeMatcher } from './schema';
import {ARGENT_CONTRACT_ADDRESS, RPC_URL, SIGNER_PRIVATE} from "../constants";

const { cleanHex, hexToDecimalString, toBigInt, toHex } = num;
const { encodeShortString } = shortString;
const { randomAddress } = stark;
const { uint256 } = cairo;

describe('deploy and test Wallet', () => {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const account = new Account(provider, ARGENT_CONTRACT_ADDRESS, SIGNER_PRIVATE);
  let erc20: Contract;
  let erc20Address: string;
  let dd: DeclareDeployUDCResponse;

  beforeAll(async () => {
    initializeMatcher(expect);
    expect(account).toBeInstanceOf(Account);

    dd = await account.declareAndDeploy({
      contract: compiledErc20,
      constructorCalldata: [
        encodeShortString('Token'),
        encodeShortString('ERC20'),
        account.address,
      ],
    });


    erc20Address = dd.deploy.contract_address;
    erc20 = new Contract(compiledErc20.abi, erc20Address, provider);

    const { balance } = await erc20.balanceOf(account.address);
    expect(BigInt(balance.low).toString()).toStrictEqual(BigInt(1000).toString());

  });

  test('estimateInvokeFee Cairo 0', async () => {
    const innerInvokeEstFeeSpy = jest.spyOn(account.signer, 'signTransaction');
    const result = await account.estimateInvokeFee({
      contractAddress: erc20Address,
      entrypoint: 'transfer',
      calldata: [erc20.address, '10', '0'],
    });

    expect(result).toMatchSchemaRef('EstimateFee');
    expect(innerInvokeEstFeeSpy.mock.calls[0][1].version).toBe(hash.feeTransactionVersion);
    innerInvokeEstFeeSpy.mockClear();
  });

  describeIfDevnetSequencer('Test on Devnet Sequencer', () => {
    test('deployAccount with rawArgs - test on devnet', async () => {
      const priKey = stark.randomAddress();
      const pubKey = ec.starkCurve.getStarkKey(priKey);

      const calldata = { publicKey: pubKey };

      // declare account
      const declareAccount = await account.declare({
        contract: compiledOpenZeppelinAccount,
      });
      const accountClassHash = declareAccount.class_hash;
      await account.waitForTransaction(declareAccount.transaction_hash);

      // fund new account
      const tobeAccountAddress = hash.calculateContractAddressFromHash(
        pubKey,
        accountClassHash,
        calldata,
        0
      );
      const devnetERC20Address =
        '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7';
      const { transaction_hash } = await account.execute({
        contractAddress: devnetERC20Address,
        entrypoint: 'transfer',
        calldata: {
          recipient: tobeAccountAddress,
          amount: uint256(5 * 10 ** 15),
        },
      });
      await account.waitForTransaction(transaction_hash);

      // deploy account
      const accountOZ = new Account(provider, tobeAccountAddress, priKey);
      const deployed = await accountOZ.deploySelf({
        classHash: accountClassHash,
        constructorCalldata: calldata,
        addressSalt: pubKey,
      });
      const receipt = await account.waitForTransaction(deployed.transaction_hash);
      expect(receipt).toMatchSchemaRef('GetTransactionReceiptResponse');
    });

    test('deploy with rawArgs', async () => {
      const deployment = await account.deploy({
        classHash: erc20ClassHash,
        constructorCalldata: {
          name: 'Token',
          symbol: 'ERC20',
          recipient: account.address,
        },
      });
      expect(deployment).toMatchSchemaRef('MultiDeployContractResponse');
    });

    test('multideploy with rawArgs', async () => {
      const deployments = await account.deploy([
        {
          classHash: '0x04367b26fbb92235e8d1137d19c080e6e650a6889ded726d00658411cc1046f5',
        },
        {
          classHash: erc20ClassHash,
          constructorCalldata: {
            name: 'Token',
            symbol: 'ERC20',
            recipient: account.address,
          },
        },
      ]);
      expect(deployments).toMatchSchemaRef('MultiDeployContractResponse');
    });
  });

  test('read balance of wallet', async () => {
    const { balance } = await erc20.balanceOf(account.address);

    expect(BigInt(balance.low).toString()).toStrictEqual(BigInt(1000).toString());
  });

  test('execute by wallet owner', async () => {
    const { transaction_hash } = await account.execute({
      contractAddress: erc20Address,
      entrypoint: 'transfer',
      calldata: [erc20.address, '10', '0'],
    });

    await provider.waitForTransaction(transaction_hash);
  });

  test('read balance of wallet after transfer', async () => {
    const { balance } = await erc20.balanceOf(account.address);

    expect(balance.low).toStrictEqual(toBigInt(990));
  });

  test('execute with custom nonce', async () => {
    const result = await account.getNonce();
    const nonce = toBigInt(result);
    const { transaction_hash } = await account.execute(
      {
        contractAddress: erc20Address,
        entrypoint: 'transfer',
        calldata: [account.address, '10', '0'],
      },
      undefined,
      { nonce }
    );

    await provider.waitForTransaction(transaction_hash);
  });

  test('execute multiple transactions', async () => {

    const { transaction_hash } = await account.execute([{
        contractAddress: erc20Address,
        entrypoint: 'transfer',
        calldata: [erc20.address, '10', '0'],
      },
      {
        contractAddress: erc20Address,
        entrypoint: 'transfer',
        calldata: [erc20.address, '10', '0'],
      }]);

    await provider.waitForTransaction(transaction_hash);

    const { balance } = await erc20.balanceOf(account.address);

    expect(balance.low).toStrictEqual(toBigInt(970));
  });

  describe('Contract interaction with Account', () => {
    const wallet = stark.randomAddress();

    beforeAll(async () => {
      const mintResponse = await account.execute({
        contractAddress: erc20Address,
        entrypoint: 'mint',
        calldata: [wallet, '1000', '0'],
      });

      await provider.waitForTransaction(mintResponse.transaction_hash);
    });

    test('change from provider to account', async () => {
      expect(erc20.providerOrAccount).toBeInstanceOf(RpcProvider);
      erc20.connect(account);
      expect(erc20.providerOrAccount).toBeInstanceOf(Account);
    });

    test('estimate gas fee for `mint`', async () => {
      const res = await erc20.estimateFee.mint(wallet, uint256('10'));
      expect(res).toHaveProperty('overall_fee');
    });

    test('Declare ERC20 contract', async () => {
      const declareTx = await account.declareIfNot({
        contract: compiledErc20,
        classHash: '0x54328a1075b8820eb43caf0caa233923148c983742402dcfc38541dd843d01a',
      });
      if (declareTx.transaction_hash) {
        await provider.waitForTransaction(declareTx.transaction_hash);
      }
      expect(declareTx).toMatchSchemaRef('DeclareContractResponse');
    });

    test('Get the stark name of the account and account from stark name (using starknet.id)', async () => {
      // Deploy naming contract
      const namingResponse = await account.declareAndDeploy({
        contract: compiledNamingContract,
      });
      const namingAddress = namingResponse.deploy.contract_address;

      // Deploy Starknet id contract
      const idResponse = await account.declareAndDeploy({
        contract: compiledStarknetId,
      });
      const idAddress = idResponse.deploy.contract_address;

      // Create signature from private key
      const whitelistingPublicKey =
        '1893860513534673656759973582609638731665558071107553163765293299136715951024';
      const whitelistingPrivateKey =
        '301579081698031303837612923223391524790804435085778862878979120159194507372';
      const hashed = ec.starkCurve.pedersen(
        ec.starkCurve.pedersen(toBigInt('18925'), toBigInt('1922775124')),
        toBigInt(account.address)
      );
      const signed = ec.starkCurve.sign(hashed, toHex(whitelistingPrivateKey));

      const { transaction_hash } = await account.execute([
        {
          contractAddress: namingAddress,
          entrypoint: 'initializer',
          calldata: [
            idAddress, // starknetid_contract_addr
            '0', // pricing_contract_addr
            account.address, // admin
            whitelistingPublicKey, // whitelisting_key
            '0', // l1_contract
          ],
        },
        {
          contractAddress: idAddress,
          entrypoint: 'mint',
          calldata: ['1'], // TokenId
        },
        {
          contractAddress: namingAddress,
          entrypoint: 'whitelisted_mint',
          calldata: [
            '18925', // Domain encoded "ben"
            '1922775124', // Expiry
            '1', // Starknet id linked
            account.address, // receiver_address
            signed.r, // sig 0 for whitelist
            signed.s, // sig 1 for whitelist
          ],
        },
        {
          contractAddress: namingAddress,
          entrypoint: 'set_address_to_domain',
          calldata: [
            '1', // length
            '18925', // Domain encoded "ben"
          ],
        },
      ]);

      await provider.waitForTransaction(transaction_hash);

      const address = await account.getAddressFromStarkName('ben.stark', namingAddress);
      expect(hexToDecimalString(address as string)).toEqual(hexToDecimalString(account.address));

      const name = await account.getStarkName(undefined, namingAddress);
      expect(name).toEqual('ben.stark');
    });
  });

  describe('Declare and UDC Deploy Flow', () => {
    test('ERC20 Declare', async () => {
      const declareTx = await account.declareIfNot({
        contract: compiledErc20,
      });

      if (declareTx.transaction_hash) {
        await provider.waitForTransaction(declareTx.transaction_hash);
      }
      expect(declareTx).toMatchSchemaRef('DeclareContractResponse');
      expect(hexToDecimalString(declareTx.class_hash)).toEqual(hexToDecimalString(erc20ClassHash));
    });

    test('UDC DeployContract', async () => {
      const deployResponse = await account.deployContract({
        classHash: erc20ClassHash,
        constructorCalldata: [
          encodeShortString('Token'),
          encodeShortString('ERC20'),
          account.address,
        ],
      });
      expect(deployResponse).toMatchSchemaRef('DeployContractUDCResponse');
    });

    test('UDC Deploy unique', async () => {
      const salt = randomAddress(); // use random salt

      const deployment = await account.deploy({
        classHash: erc20ClassHash,
        constructorCalldata: [
          encodeShortString('Token'),
          encodeShortString('ERC20'),
          account.address,
        ],
        salt,
        unique: true,
      });
      expect(deployment).toMatchSchemaRef('MultiDeployContractResponse');

      // check pre-calculated address
      const txReceipt = await provider.waitForTransaction(deployment.transaction_hash);
      const udcEvent = parseUDCEvent(txReceipt as DeployTransactionReceiptResponse);
      expect(cleanHex(deployment.contract_address[0])).toBe(cleanHex(udcEvent.contract_address));
    });

    test('UDC Deploy non-unique', async () => {
      const salt = randomAddress(); // use random salt

      const deployment = await account.deploy({
        classHash: erc20ClassHash,
        constructorCalldata: [
          encodeShortString('Token'),
          encodeShortString('ERC20'),
          account.address,
        ],
        salt,
        unique: false,
      });
      expect(deployment).toMatchSchemaRef('MultiDeployContractResponse');

      // check pre-calculated address
      const txReceipt = await provider.waitForTransaction(deployment.transaction_hash);
      const udcEvent = parseUDCEvent(txReceipt as DeployTransactionReceiptResponse);
      expect(cleanHex(deployment.contract_address[0])).toBe(cleanHex(udcEvent.contract_address));
    });

    test('UDC multi Deploy', async () => {
      const deployments = await account.deploy([
        {
          classHash: '0x04367b26fbb92235e8d1137d19c080e6e650a6889ded726d00658411cc1046f5',
        },
        {
          classHash: erc20ClassHash,
          constructorCalldata: [
            encodeShortString('Token'),
            encodeShortString('ERC20'),
            account.address,
          ],
        },
      ]);
      expect(deployments).toMatchSchemaRef('MultiDeployContractResponse');

      await provider.waitForTransaction(deployments.transaction_hash);
    });
  });

  describe('Estimate fee bulk & estimate fee', () => {
    let accountClassHash: string;
    let precalculatedAddress: string;
    let starkKeyPub: string;
    let newAccount: Account;

    beforeAll(async () => {
      const declareAccount = await account.declareIfNot({
        contract: compiledOpenZeppelinAccount,
      });
      accountClassHash = declareAccount.class_hash;
      if (declareAccount.transaction_hash) {
        await provider.waitForTransaction(declareAccount.transaction_hash);
      }
      const privateKey = stark.randomAddress();
      starkKeyPub = ec.starkCurve.getStarkKey(privateKey);
      precalculatedAddress = hash.calculateContractAddressFromHash(
        starkKeyPub,
        accountClassHash,
        { publicKey: starkKeyPub },
        0
      );
      newAccount = new Account(provider, precalculatedAddress, privateKey);
    });

    test('estimateAccountDeployFee Cairo 0', async () => {

      // const innerInvokeEstFeeSpy = jest.spyOn(account.signer, 'signTransaction');
      const result = await newAccount.estimateAccountDeployFee({
        classHash: accountClassHash,
        constructorCalldata: { publicKey: starkKeyPub },
        addressSalt: starkKeyPub,
        contractAddress: precalculatedAddress,
      });
      expect(result).toMatchSchemaRef('EstimateFee');
    });

    test('estimate fee bulk invoke functions', async () => {
      // TODO @dhruvkelawala check expectation for feeTransactionVersion
      // const innerInvokeEstFeeSpy = jest.spyOn(account.signer, 'signTransaction');
      const estimatedFeeBulk = await account.estimateFeeBulk([
        {
          type: TransactionType.INVOKE,
          payload: {
            contractAddress: erc20Address,
            entrypoint: 'transfer',
            calldata: [erc20.address, '10', '0'],
          },
        },
        {
          type: TransactionType.INVOKE,
          payload: {
            contractAddress: erc20Address,
            entrypoint: 'transfer',
            calldata: [erc20.address, '10', '0'],
          },
        },
      ]);

      estimatedFeeBulk.forEach((value) => {
        expect(value).toMatchSchemaRef('EstimateFee');
      });
      expect(estimatedFeeBulk.length).toEqual(2);
      // expect(innerInvokeEstFeeSpy.mock.calls[0][1].version).toBe(feeTransactionVersion);
      // innerInvokeEstFeeSpy.mockClear();
    });

    test('deploy account & multi invoke functions', async () => {
      const { transaction_hash } = await account.execute({
        contractAddress: erc20Address,
        entrypoint: 'transfer',
        calldata: [precalculatedAddress, uint256(10)],
      });
      await provider.waitForTransaction(transaction_hash);

      const res = await newAccount.estimateFeeBulk([
        {
          type: TransactionType.DEPLOY_ACCOUNT,
          payload: {
            classHash: accountClassHash,
            constructorCalldata: { publicKey: starkKeyPub },
            addressSalt: starkKeyPub,
            contractAddress: precalculatedAddress,
          },
        },
        {
          type: TransactionType.INVOKE,
          payload: [
            {
              contractAddress: erc20Address,
              entrypoint: 'approve',
              calldata: { address: account.address, amount: uint256(10) },
            },
            {
              contractAddress: erc20Address,
              entrypoint: 'transfer',
              calldata: [account.address, uint256(10)],
            },
          ],
        },
      ]);
      expect(res).toHaveLength(2);
      res.forEach((value) => {
        expect(value).toMatchSchemaRef('EstimateFee');
      });
    });

    describeIfDevnet('declare tests only on devnet', () => {
      test('declare, deploy & multi invoke functions', async () => {
        const res = await account.estimateFeeBulk([
          /*         {
            // Cairo 1.1.0, if declared estimate error with can't redeclare same contract
            type: TransactionType.DECLARE,
            contract: compiledHelloSierra,
            casm: compiledHelloSierraCasm,
          }, */
          {
            // Cairo 0
            type: TransactionType.DECLARE,
            payload: {
              contract: compiledErc20,
              classHash: '0x54328a1075b8820eb43caf0caa233923148c983742402dcfc38541dd843d01a',
            },
          },
          {
            type: TransactionType.DEPLOY,
            payload: {
              classHash: '0x54328a1075b8820eb43caf0caa233923148c983742402dcfc38541dd843d01a',
              constructorCalldata: ['Token', 'ERC20', account.address],
            },
          },
          {
            type: TransactionType.INVOKE,
            payload: [
              {
                contractAddress: erc20Address,
                entrypoint: 'approve',
                calldata: {
                  address: erc20Address,
                  amount: uint256(10),
                },
              },
              {
                contractAddress: erc20Address,
                entrypoint: 'transfer',
                calldata: [erc20.address, '10', '0'],
              },
            ],
          },
        ]);
        expect(res).toHaveLength(3);
        res.forEach((value) => {
          expect(value).toMatchSchemaRef('EstimateFee');
        });
      });
    });

    // Order is important, declare c1 must be last else estimate and simulate will error
    // with contract already declared
    test('estimateInvokeFee Cairo 1', async () => {
      // TODO @dhruvkelawala check expectation for feeTransactionVersion
      // Cairo 1 contract
      const ddc1: DeclareDeployUDCResponse = await account.declareAndDeploy({
        contract: compiledHelloSierra,
        casm: compiledHelloSierraCasm,
      });

      const result = await account.estimateInvokeFee({
        contractAddress: ddc1.deploy.address,
        entrypoint: 'increase_balance',
        calldata: [100],
      });

      expect(result).toMatchSchemaRef('EstimateFee');
    });
  });
});

describe('unit', () => {
  describeIfDevnetSequencer('devnet sequencer', () => {
    initializeMatcher(expect);
    const provider = new RpcProvider({ nodeUrl: RPC_URL });
    const account = new Account(provider, ARGENT_CONTRACT_ADDRESS, SIGNER_PRIVATE);

    test('declareIfNot', async () => {
      const declare = await account.declareIfNot({
        contract: compiledHelloSierra,
        casm: compiledHelloSierraCasm,
      });
      expect(declare).toMatchSchemaRef('DeclareContractResponse');

      await expect(
        account.declare({
          contract: compiledHelloSierra,
          casm: compiledHelloSierraCasm,
        })
      ).rejects.toThrow();

      const redeclare = await account.declareIfNot({
        contract: compiledHelloSierra,
        casm: compiledHelloSierraCasm,
      });
      expect(redeclare.class_hash).toBe(declare.class_hash);
    });
  });
});
