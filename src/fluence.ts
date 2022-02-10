import BN from 'bn.js';
import { BigNumber, Contract, Signer } from 'ethers';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import fluenceABI from './Fluence.json';

export class Fluence {
  static fluence(address: string, signer: Signer) {
    return new Contract(address, fluenceABI, signer);
  }

  constructor(private fluence: Contract, private l2ContractAddress: string) {
  }

  async deposit(to: BN, amountOrTokenId: BN, contract?: Contract): Promise<string[]> {
    const user = BigNumber.from(String(to));
    const n = BigNumber.from(String(amountOrTokenId));
    if (!contract) {
      const tx: TransactionResponse = await this.fluence['deposit(uint256,uint256)'](
        this.l2ContractAddress, user, { value: n, gasLimit: 100000 });

      return [tx.hash];
    }

    return [
      await contract.approve(this.fluence.address, n),
      await this.fluence['deposit(uint256,uint256,uint256,address)'](
        this.l2ContractAddress, user, n, contract.address, { gasLimit: 150000 }),
    ].map(({ hash }: TransactionResponse) => hash);
  }

  async withdraw(account: string, amountOrTokenId: BN, nonce: BN, contract?: string, mint?: boolean): Promise<string> {
    const tx: TransactionResponse = await this.fluence.withdraw(
      this.l2ContractAddress,
      account,
      BigNumber.from(String(amountOrTokenId)),
      contract || '0x0000000000000000000000000000000000000000',
      mint || false,
      BigNumber.from(String(nonce)),
      { gasLimit: 200000 }
    );

    return tx.hash;
  }
}

export { fluenceABI };
