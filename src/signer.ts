import BN from 'bn.js';
import { ec } from 'elliptic';
import { hexToBuffer } from 'enc-utils';
import { hdkey } from 'ethereumjs-wallet';
import { Signer, utils } from 'ethers';
import { getAccountPath, grindKey, pedersen, sign, starkEc } from '@phanalpha/starkcrypto';

export type BNLike = ConstructorParameters<typeof BN>[0];

export interface StackSigner {
  deriveStarkKey(): Promise<BN>;
  sign(message: BNLike[]): Promise<[BN, ec.Signature]>;
}

export class Web3StarkSigner implements StackSigner {
  constructor(private signer: Signer, private layer: string, private application: string, private message: string) {
  }

  async deriveStarkKey(): Promise<BN> {
    const kp = await this.deriveKeyPair();

    return kp.getPublic().getX();
  }

  async sign(message: BNLike[]): Promise<[BN, ec.Signature]> {
    const kp = await this.deriveKeyPair();
    const hash = message.reduceRight<BN>((h, n) => pedersen([n, h]), new BN(0));

    return [kp.getPublic().getX(), sign(kp, String(hash))];
  }

  private async deriveKeyPair(): Promise<ec.KeyPair> {
    const signature_str = await this.signer.signMessage(this.message);
    const signature = utils.splitSignature(signature_str);
    const path = getAccountPath(this.layer, this.application, await this.signer.getAddress(), 1);
    const derived = hdkey
      .fromMasterSeed(hexToBuffer(signature.s))
      .derivePath(path)
      .getWallet()
      .getPrivateKeyString();

    return starkEc.keyFromPrivate(grindKey(derived, starkEc.n as BN), 'hex');
  }
}
