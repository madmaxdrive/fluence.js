import BN from 'bn.js';

export interface Nonce {
  next(): BN;
}

export class TimestampNonce implements Nonce {
  next() {
    return new BN(Date.now() / 1e3);
  }
}
