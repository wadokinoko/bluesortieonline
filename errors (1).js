import { ERR_TEXT } from '../../shared/protocol.js';

export class NetError extends Error {
  constructor(code, msg) {
    super(msg || ERR_TEXT[code] || code);
    this.name = 'NetError';
    this.code = code;
  }
}
