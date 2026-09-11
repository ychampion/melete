import type { BrokerErrorCode } from '@melete/contracts';

export class BrokerFault extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
