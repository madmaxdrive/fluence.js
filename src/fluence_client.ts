import { AxiosInstance } from 'axios';
import BN from 'bn.js';
import { ec } from 'elliptic';
import { Contract, Signer } from 'ethers';
import sha1 from 'crypto-js/sha1';
import { BNLike, StarkSigner } from './signer';
import { Nonce, TimestampNonce } from './nonce';

import forwarderABI from './FluenceForwarder.json';

interface Tx {
  transaction_hash: string;
}

export enum OrderState {
  New = 0,
  Fulfilled = 1,
  Cancelled = 2,
}

export interface Account {
  readonly stark_key: string;
  readonly address?: string;
}

export interface Blueprint {
  readonly permanent_id?: string;
  readonly minter: Account;
  readonly expire_at?: string;
}

interface BaseCollection {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly image: string;
  readonly background_image?: string;
  readonly description?: string;
}

export interface NewCollection extends BaseCollection {
  readonly baseURI: string;
  readonly blueprint?: string;
}

export interface Collection extends BaseCollection {
  readonly fungible: boolean;
  readonly decimals: number;
}

export interface CollectionVerbose extends Collection {
  readonly blueprint?: Blueprint;
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

export interface TokenVerbose extends Token {
  readonly owner?: Account;
  readonly ask?: BaseLimitOrder;
}

export interface BaseLimitOrder {
  readonly order_id: string;
  readonly bid: boolean;
  readonly quote_contract: Collection;
  readonly quote_amount: string;
  readonly state: 'NEW' | 'FULFILLED' | 'CANCELLED';
}

export interface LimitOrder extends BaseLimitOrder {
  readonly user: Account;
  readonly token: Token;
}

export interface PlainLimitOrder {
  readonly user: string;
  readonly bid: boolean;
  readonly base_contract: string;
  readonly base_token_id: string;
  readonly quote_contract: string;
  readonly quote_amount: string;
  readonly state: 'NEW' | 'FULFILLED' | 'CANCELLED';
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

export class StarkWallet implements StarkSigner {
  private _nonce: Nonce;

  constructor(private _signer: StarkSigner, nonce?: Nonce) {
    this._nonce = nonce || new TimestampNonce();
  }

  deriveStarkKey(): Promise<BN> {
    return this._signer.deriveStarkKey();
  }

  sign(message: BNLike[]): Promise<[BN, ec.Signature]> {
    return this._signer.sign(message);
  }

  nonce() {
    return this._nonce.next();
  }
}

export class FluenceClient {
  static forwarder(address: string, signer: Signer) {
    return new Contract(address, forwarderABI, signer);
  }

  constructor(private a: AxiosInstance) {
  }

  async registerClient(account: string, wallet: StarkWallet): Promise<string> {
    const nonce = wallet.nonce();
    const [starkKey, { r, s }] = await wallet.sign([parseN(account), nonce]);
    const { data } = await this.a.post<Tx>(`/clients?signature=${r},${s}`, {
      stark_key: String(starkKey),
      address: account,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async getClient(account: string): Promise<BN> {
    const { data } = await this.a.get<{ stark_key: string }>(`/clients/${account}`);

    return parseN(data.stark_key)
  }

  async createBlueprint(permanentId: string, signer: StarkSigner): Promise<void> {
    const [starkKey, { r, s }] = await signer.sign([sha1n(permanentId)]);

    await this.a.post(`/blueprints?signature=${r},${s}`, {
      permanent_id: permanentId,
      minter: String(starkKey),
    });
  }

  async findCollections(params: Pagination & {
    owner?: string;
    fungible?: boolean;
  }): Promise<Fragment<CollectionVerbose>> {
    const { data } = await this.a.get<Fragment<CollectionVerbose>>('/collections', { params })

    return data;
  }

  async getCollection(contract: string): Promise<CollectionVerbose> {
    const { data } = await this.a.get<CollectionVerbose>(`/collections/${contract}`);

    return data;
  }

  async registerCollection(
    { address, name, symbol, baseURI, image, background_image, description, blueprint }: NewCollection,
    signer: StarkSigner,
    forwarder: Contract): Promise<string> {
    const [starkKey, { r, s }] = await signer.sign([
      parseN(address),
      sha1n(name),
      sha1n(symbol),
      sha1n(baseURI),
      sha1n(image),
      sha1n(background_image || ''),
      sha1n(description || ''),
    ]);
    const { data } = await this.a.post<{ req: any, signature: string }>(
      `/collections?signature=${r},${s}`,
      { address,
        name,
        symbol,
        base_uri: baseURI,
        image,
        ...background_image && { background_image },
        ...description && { description },
        ...blueprint ? { blueprint } : { minter: String(starkKey) } });
    const tx = await forwarder.execute(data.req, data.signature, { gasLimit: 200000 });

    return tx.hash;
  }

  async findMetadata<T extends Metadata = Metadata>(contract: string, tokenId: BN): Promise<T> {
    const { data } = await this.a.get<T>(`/collections/${contract}/tokens/${tokenId}/_metadata`);

    return data;
  }

  async saveMetadata<T extends Metadata>(
    contract: string, tokenId: BN, nonce: BN, metadata: T, signer: StarkSigner): Promise<Token> {
    const [_, { r, s }] = await signer.sign([ parseN(contract), tokenId, nonce ]);
    const { data } = await this.a.put<Token>(
      `/collections/${contract}/tokens/${tokenId}/_metadata?signature=${r},${s}`, metadata);

    return data;
  }

  async findTokens(params: Pagination & {
    q?: string;
    owner?: string;
    collection?: string;
    sort?: 'token_id' | 'name';
    asc?: boolean;
  }): Promise<Fragment<TokenVerbose>> {
    const { data } = await this.a.get<Fragment<TokenVerbose>>('/tokens', { params });

    return data;
  }

  async getToken(contract: string, tokenId: string): Promise<TokenVerbose> {
    const { data } = await this.a.get<TokenVerbose>(`/collections/${contract}/tokens/${tokenId}`);

    return data;
  }

  async getBalance(user: BN, contract?: string): Promise<BN> {
    const { data } = await this.a.get<{ balance: number }>('/balance', {
      params: {
        user: String(user),
        contract: contract || 0,
      },
    });

    return new BN(data.balance);
  }

  async getOwner(tokenId: BN, contract: string): Promise<BN> {
    const { data } = await this.a.get<{ owner: string }>('/owner', {
      params: {
        token_id: String(tokenId),
        contract,
      }
    });

    return new BN(data.owner);
  }

  async mint(to: BN, tokenId: BN, contract: string, wallet: StarkWallet): Promise<string> {
    const nonce = wallet.nonce();
    const [_, { r, s }] = await wallet.sign([to, tokenId, parseN(contract), nonce]);
    const { data } = await this.a.post<Tx>(`/mint?signature=${r},${s}`, {
      user: String(to),
      token_id: String(tokenId),
      contract,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async withdraw(wallet: StarkWallet, account: string, amountOrTokenId: BN, contract?: string): Promise<[string, BN]> {
    const nonce = wallet.nonce();
    const [starkKey, { r, s }] = await wallet.sign([
      amountOrTokenId,
      parseN(contract || '0'),
      parseN(account),
      nonce,
    ]);
    const { data } = await this.a.post<Tx>(`/withdraw?signature=${r},${s}`, {
      user: String(starkKey),
      amount_or_token_id: String(amountOrTokenId),
      contract: contract || '0',
      address: account,
      nonce: String(nonce),
    });

    return [data.transaction_hash, nonce];
  }

  async transfer(wallet: StarkWallet, to: BN, amountOrTokenId: BN, contract: string): Promise<string> {
    const nonce = wallet.nonce();
    const [starkKey, { r, s }] = await wallet.sign([
      to,
      amountOrTokenId,
      parseN(contract),
      nonce,
    ]);
    const { data } = await this.a.post<Tx>(`/transfer?signature=${r},${s}`, {
      from: String(starkKey),
      to: String(to),
      amount_or_token_id: String(amountOrTokenId),
      contract,
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async findOrders(params: Pagination & {
    q?: string;
    user?: string;
    collection?: string;
    side?: 'ask' | 'bid';
    state?: OrderState;
    sort?: 'price';
    asc?: boolean;
  }): Promise<Fragment<LimitOrder>> {
    const { data } = await this.a.get<Fragment<LimitOrder>>('/orders', { params });

    return data;
  }

  async createOrder(
    signer: StarkSigner,
    orderId: BN,
    bid: boolean,
    baseContract: string,
    baseTokenId: BN,
    quoteContract: string,
    quoteAmount: BN): Promise<string> {
    const [starkKey, { r, s }] = await signer.sign([
      orderId,
      new BN(Number(bid)),
      parseN(baseContract),
      baseTokenId,
      parseN(quoteContract),
      quoteAmount,
    ]);
    const { data } = await this.a.post<Tx>(`/orders?signature=${r},${s}`, {
      order_id: String(orderId),
      user: String(starkKey),
      bid,
      base_contract: baseContract,
      base_token_id: String(baseTokenId),
      quote_contract: quoteContract,
      quote_amount: String(quoteAmount),
    });

    return data.transaction_hash;
  }

  async getOrder(id: BN): Promise<PlainLimitOrder> {
    const { data } = await this.a.get<PlainLimitOrder>(`/orders/${id}`);

    return data;
  }

  async fulfillOrder(wallet: StarkWallet, id: BN): Promise<string> {
    const nonce = wallet.nonce();
    const [starkKey, { r, s }] = await wallet.sign([id, nonce]);
    const { data } = await this.a.post<Tx>(`/orders/${id}?signature=${r},${s}`, {
      user: String(starkKey),
      nonce: String(nonce),
    });

    return data.transaction_hash;
  }

  async cancelOrder(wallet: StarkWallet, id: BN): Promise<string> {
    const nonce = wallet.nonce();
    const [_, { r, s }] = await wallet.sign([id, nonce]);
    const { data } = await this.a.delete<Tx>(`/orders/${id}?nonce=${nonce}&signature=${r},${s}`);

    return data.transaction_hash;
  }
}

export { forwarderABI };
