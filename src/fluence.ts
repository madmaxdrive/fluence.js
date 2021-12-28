import { AxiosInstance } from 'axios';
import BN from 'bn.js';
import { BigNumber, Contract, Signer } from 'ethers';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import sha1 from 'crypto-js/sha1';
import { BNLike, StackSigner } from './signer';
import fluenceABI from './Fluence.json';
import forwarderABI from './FluenceForwarder.json';
import { Nonce, TimestampNonce } from './nonce';

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

export interface Account {
  readonly stark_key: string;
  readonly address?: string;
}

export interface Blueprint {
  readonly permanent_id?: string;
  readonly minter?: Account;
  readonly expire_at?: string;
}

interface BaseCollection {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly baseURI: string;
  readonly image: string;
}

export interface NewCollection extends BaseCollection {
  readonly blueprint?: string;
}

export interface Collection extends BaseCollection {
  readonly fungible: boolean;
  readonly blueprint: Blueprint;
}

export interface Metadata {
  readonly name: string;
  readonly description: string;
  readonly image: string;
}

export interface Token extends Metadata {
  readonly contract: Collection;
  readonly token_id: string;
}

export interface Pagination {
  readonly page?: number;
  readonly size?: number;
}

export interface Fragment<T> {
  readonly data: T[];
  readonly total: number;
}

export function sha1n(permanentId: string) {
  return new BN(String(sha1(permanentId)), 16);
}

export function parseN(s: string): BN {
  return s.toLowerCase().startsWith('0x') ? new BN(s.slice(2), 16) : new BN(s);
}

export class Fluence {
  static contract(address: string, signer: Signer) {
    return new Contract(address, fluenceABI, signer);
  }

  static forwarder(address: string, signer: Signer) {
    return new Contract(address, forwarderABI, signer);
  }

  private nonce: Nonce;

  constructor(
    private a: AxiosInstance,
    private fluence: Contract,
    private forwarder: Contract,
    private l2ContractAddress: string,
    nonce?: Nonce) {
    this.nonce = nonce || new TimestampNonce();
  }

  async registerClient(account: string, signer: StackSigner): Promise<string> {
    const nonce = this.nonce.next();
    const [starkKey, { r, s }] = await signer.sign([parseN(account), nonce]);
    const { data } = await this.a.post<Tx>(`/clients?signature=${r},${s}`, {
      stark_key: String(starkKey),
      address: account,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async getClient(account: string): Promise<BN> {
    const { data } = await this.a.get<{ stark_key: string }>('/clients', {
      params: {
        address: account,
      },
    });

    return parseN(data.stark_key)
  }

  async createBlueprint(permanentId: string, signer: StackSigner): Promise<void> {
    const [starkKey, { r, s }] = await signer.sign([sha1n(permanentId)]);

    await this.a.post(`/blueprints?signature=${r},${s}`, {
      permanent_id: permanentId,
      minter: String(starkKey),
    });
  }

  async registerCollection(
    { address, name, symbol, baseURI, image, blueprint }: NewCollection,
    signer: StackSigner): Promise<string> {
    const [starkKey, { r, s }] = await signer.sign([
      parseN(address), sha1n(name), sha1n(symbol), sha1n(baseURI), sha1n(image) ]);
    const { data } = await this.a.post<{ req: any, signature: string }>(
      `/collections?signature=${r},${s}`,
      { address, name, symbol, base_uri: baseURI, image, blueprint, minter: String(starkKey) });
    const tx = await this.forwarder.execute(data.req, data.signature, { gasLimit: 200000 });

    return tx.hash;
  }

  async findCollections(params: Pagination & { owner?: string }): Promise<Fragment<Collection>> {
    const { data } = await this.a.get<Fragment<Collection>>('/collections', { params })

    return data;
  }

  async saveMetadata<T extends Metadata>(
    contract: string, tokenId: BN, nonce: BN, metadata: T, signer: StackSigner): Promise<Token> {
    const [_, { r, s }] = await signer.sign([ parseN(contract), tokenId, nonce ]);
    const { data } = await this.a.put<Token>(
      `/collections/${contract}/tokens/${tokenId}/_metadata?signature=${r},${s}`, metadata);

    return data;
  }

  async findMetadata<T extends Metadata = Metadata>(contract: string, tokenId: BN): Promise<T> {
    const { data } = await this.a.get<T>(`/collections/${contract}/tokens/${tokenId}/_metadata`);

    return data;
  }

  async mint(to: BN, tokenId: BN, contract: string, signer: StackSigner): Promise<string> {
    const nonce = this.nonce.next();
    const [_, { r, s }] = await signer.sign([to, tokenId, parseN(contract), nonce]);
    const { data } = await this.a.post<Tx>(`/mint?signature=${r},${s}`, {
      user: String(to),
      amount_or_token_id: tokenId,
      contract,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async findTokens(params: Pagination & { owner?: string, collection: string; }): Promise<Fragment<Token>> {
    const { data } = await this.a.get<Fragment<Token>>(`/tokens`, { params });

    return data;
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

  async transfer(signer: StackSigner, amountOrTokenId: BNLike, contract: string, to: BNLike) {
    const nonce = this.nonce.next();
    const [starkKey, { r, s }] = await signer.sign([
      to,
      amountOrTokenId,
      new BN(contract?.slice(2) || 0, 16),
      nonce,
    ]);
    const { data } = await this.a.post<Tx>(`/transfer?signature=${r},${s}`, {
      from: String(starkKey),
      to: String(to),
      'amount_or_token_id': amountOrTokenId,
      contract,
      nonce: String(nonce)
    });

    return data.transaction_hash;
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
    const nonce = this.nonce.next();
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
    const nonce = this.nonce.next();
    const [_, { r, s }] = await signer.sign([id, nonce]);
    const { data } = await this.a.delete<Tx>(`/orders/${id}?signature=${r},${s}&nonce=${nonce}`);

    return data.transaction_hash;
  }

  async fulfillOrder(signer: StackSigner, id: BNLike): Promise<string> {
    const nonce = this.nonce.next();
    const [starkKey, { r, s }] = await signer.sign([id, nonce]);
    const { data } = await this.a.post<Tx>(`/orders/${id}?signature=${r},${s}`, {
      user: String(starkKey),
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }
}

export { fluenceABI, forwarderABI };
