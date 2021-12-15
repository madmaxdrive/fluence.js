import { AxiosInstance } from 'axios';
import BN from 'bn.js';
import { BigNumber, Contract, Signer } from 'ethers';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { BNLike, StackSigner } from './signer';
import fluenceABI from './fluence.json';
import forwarderABI from './MinimalForwarder.json';

interface Tx {
  transaction_hash: string;
}

export interface LimitOrder {
  readonly user: string;
  readonly bid: 0 | 1;
  readonly base_contract: string;
  readonly base_token_id: number;
  readonly quote_contract: string;
  readonly quote_amount: number;
  readonly state: number;
}

export class Fluence {
  static contract(address: string, signer: Signer) {
    return new Contract(address, fluenceABI, signer);
  }

  static forwarder(address: string, signer: Signer) {
    return new Contract(address, forwarderABI, signer);
  }

  constructor(private a: AxiosInstance, private fluence: Contract, private forwarder: Contract, private l2ContractAddress: string) {
  }

  async registerContract(contract: string, minter: BNLike): Promise<string> {
    const { data } = await this.a.post<{ req: any, signature: string }>('/contracts', {
      contract,
      minter: String(minter),
    });
    const tx = await this.forwarder.execute(data.req, data.signature, { gasLimit: 200000 });

    return tx.hash;
  }

  async registerClient(account: string, signer: StackSigner): Promise<string> {
    const nonce = new BN(Date.now() / 1e3);
    const [starkKey, { r, s }] = await signer.sign([new BN(account.slice(2), 16), nonce]);
    const { data } = await this.a.post<Tx>(`/clients?signature=${r},${s}`, {
      public_key: String(starkKey),
      address: account,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async getClient(account: string): Promise<BN> {
    const { data } = await this.a.get<{ public_key: string }>('/clients', {
      params: {
        address: account,
      },
    });

    return new BN(data.public_key.slice(2), 16);
  }

  async mint(signer: StackSigner, tokenId: BNLike, contract: string): Promise<string> {
    const { data } = await this.a.post<Tx>('/mint', {
      user: String(await signer.deriveStarkKey()),
      amount_or_token_id: tokenId,
      contract,
      token: 2,
    });

    return data.transaction_hash;
  }

  async getBalance(signer: StackSigner, contract?: string): Promise<BN> {
    const { data } = await this.a.get<{ balance: number }>('/balance', {
      params: {
        user: String(await signer.deriveStarkKey()),
        contract: contract || 0,
      },
    });

    return new BN(data.balance);
  }

  async getOwner(tokenId: BNLike, contract: string): Promise<BN> {
    const { data } = await this.a.get<{ owner: string }>('/owner', {
      params: {
        token_id: tokenId,
        contract,
      }
    });

    return new BN(data.owner);
  }

  async deposit(signer: StackSigner, amountOrTokenId: BNLike, contract?: Contract): Promise<string[]> {
    if (!contract) {
      const tx: TransactionResponse = await this.fluence['deposit(uint256,uint256)'](
        this.l2ContractAddress,
        BigNumber.from(String(await signer.deriveStarkKey())),
        { value: amountOrTokenId, gasLimit: 100000 });

      return [tx.hash];
    }

    return [
      await contract.approve(this.fluence.address, amountOrTokenId),
      await this.fluence['deposit(uint256,uint256,uint256,address)'](
        this.l2ContractAddress,
        BigNumber.from(String(await signer.deriveStarkKey())),
        amountOrTokenId,
        contract.address,
        { gasLimit: 150000 }
      ),
    ].map(({ hash }: TransactionResponse) => hash);
  }

  async withdraw(account: string, signer: StackSigner, amountOrTokenId: BNLike, contract?: string): Promise<string> {
    const nonce = new BN(Date.now() / 1e3);
    const [starkKey, { r, s }] = await signer.sign([
      amountOrTokenId,
      new BN(contract?.slice(2) || 0, 16),
      new BN(account.slice(2), 16),
      nonce,
    ]);
    const { data } = await this.a.post<Tx>(`/withdraw?signature=${r},${s}`, {
      user: String(starkKey),
      amount_or_token_id: amountOrTokenId,
      contract: contract || 0,
      address: account,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async doWithdraw(account: string, amountOrTokenId: BNLike, contract?: string, mint?: boolean) {
    const tx: TransactionResponse = await this.fluence.withdraw(
      this.l2ContractAddress,
      account,
      amountOrTokenId,
      contract || '0x0',
      mint || false,
      { gasLimit: 200000 }
    );

    return tx.hash;
  }

  async getOrder(id: BNLike): Promise<LimitOrder> {
    const { data } = await this.a.get<LimitOrder>(`/orders/${id}`);

    return data;
  }

  async createOrder(
    signer: StackSigner,
    id: BNLike,
    bid: boolean,
    baseContract: string,
    baseTokenId: BNLike,
    quoteContract: string,
    quoteAmount: BNLike): Promise<string> {
    const side = bid ? 1 : 0;
    const [starkKey, { r, s }] = await signer.sign([
      id,
      side,
      new BN(baseContract.slice(2), 16),
      baseTokenId,
      new BN(quoteContract.slice(2), 16),
      quoteAmount,
    ]);
    const { data } = await this.a.put<Tx>(`/orders/${id}?signature=${r},${s}`, {
      user: String(starkKey),
      bid: side,
      base_contract: baseContract,
      base_token_id: baseTokenId,
      quote_contract: quoteContract,
      quote_amount: quoteAmount,
    });

    return data.transaction_hash;
  }

  async cancelOrder(signer: StackSigner, id: BNLike): Promise<string> {
    const nonce = new BN(Date.now() / 1e3);
    const [_, { r, s }] = await signer.sign([id, nonce]);
    const { data } = await this.a.delete<Tx>(`/orders/${id}?signature=${r},${s}&nonce=${nonce}`);

    return data.transaction_hash;
  }

  async fulfillOrder(signer: StackSigner, id: BNLike): Promise<string> {
    const nonce = new BN(Date.now() / 1e3);
    const [starkKey, { r, s }] = await signer.sign([id, nonce]);
    const { data } = await this.a.post<Tx>(`/orders/${id}?signature=${r},${s}`, {
      user: String(starkKey),
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }
}

export { fluenceABI };
