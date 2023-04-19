import { iterateReader } from "https://deno.land/std@0.183.0/streams/iterate_reader.ts"
import { EventEmitter } from "https://deno.land/x/event@2.0.1/mod.ts"

enum State {
  Connecting, Open, Closing, Closed
}

type WebsocketEvents = {
  open: []
  close: [number | null, string | null]
  textMessage: [string]
  binaryMessage: [Uint8Array]
  raw: [Uint8Array]
}

type FrameInfo = {
  fin: boolean,
  srv: [number, number, number],
  op: string,
  maskExists: boolean,
  length: Uint8Array,
  mask: Uint8Array,
  content: Uint8Array | string | undefined | { code: number, content: string }
}

class FrameTools {
  static lastOp = ''

  static decode(data: Uint8Array): FrameInfo {
    const maskExists = (data[1] & 0b10000000) == 0b10000000
    let op = (data[0] & 0b00001111).toString(16)

    if (op == '0' && (this.lastOp == '1' || this.lastOp == '2')) {
      op = this.lastOp
    } else {
      this.lastOp = op
    }

    let length = Uint8Array.from([data[1] & 0b01111111])
    let startIndex = 0

    if (length[0] === 126) {
      length = Uint8Array.from([data[2], data[3]])
      startIndex = 2
    }
    if (length[0] === 127) {
      length = Uint8Array.from([data[2], data[3], data[4], data[5], data[6], data[7], data[8], data[9]])
      startIndex = 8
    }

    let mask: Uint8Array = new Uint8Array(0)

    if (maskExists) {
      mask = Uint8Array.from([data[startIndex], data[1 + startIndex], data[2 + startIndex], data[3 + startIndex]])
      startIndex += 4
    }

    const contentRaw = data.slice(2 + startIndex, 2 + startIndex + length.reduce((sum, acc) => sum + acc, 0))

    const content = (length[0] > 0 && op == '1')
      ? new TextDecoder().decode(contentRaw)
      : (length[0] > 0 && op == '2')
        ? contentRaw
        : (length[0] > 0 && op == '8')
          ? { code: ((contentRaw[0] << 8) + contentRaw[1]), content: new TextDecoder().decode(contentRaw.slice(2)) }
          : undefined

    return {
      fin: (data[0] & 0b10000000) == 0b10000000,
      srv: [
        data[0] & 0b01000000,
        data[0] & 0b00100000,
        data[0] & 0b00010000
      ],
      op,
      maskExists,
      length,
      mask,
      content
    }
  }

  static encode(data: FrameInfo): Uint8Array {
    const firstByte = ((data.fin ? 1 : 0) << 7) | (data.srv[0] << 6) | (data.srv[1] << 5) | (data.srv[2] << 4) | parseInt(data.op, 16)

    const length = [(data.maskExists ? 1 : 0) << 7 | data.length[0], ...data.length.slice(1)]

    const decodedContent = (typeof data.content == 'string')
      ? new TextEncoder().encode(data.content)
      : (data.content === undefined)
        ? Uint8Array.from([])
        : data.content as Uint8Array

    const content = data.maskExists ? decodedContent.map((elt, i) => elt ^ data.mask[i % 4]) : decodedContent

    return Uint8Array.from([firstByte, ...length, ...data.mask, ...content])
  }
}

export default class SimpleWebSocket extends EventEmitter<WebsocketEvents> {
  port = 80
  url: URL
  #connection: Deno.Conn | undefined
  state: State = State.Closed
  #isWSMode = false
  #sentClosed = false

  headers: { [key: string]: string } = {}

  public get isSecure(): boolean {
    return this.url.protocol === 'wss:'
  }

  constructor(url: string | undefined, options?: { port?: number, headers?: { [key: string]: string } }) {
    super()
    this.port = (url?.startsWith('wss://') || url?.startsWith('https://')) ? 443 : 80
    if (Number.isInteger(options?.port)) {
      this.port = options!.port!
    }

    this.url = new URL(url === undefined ? 'http://127.0.0.1' : url)
    this.headers = options?.headers === undefined ? {} : options.headers
  }

  async connect() {
    const connection = this.isSecure
      ? Deno.connectTls({ hostname: this.url.hostname, port: this.port })
      : Deno.connect({ hostname: this.url.hostname, port: this.port })

    await this.setConnection(connection).catch((err) => { this.state = State.Closed; throw err })

    await this.upgradeAndListen(this.headers)

    for await (const chunk of iterateReader(this.#connection!)) {
      this.#isWSMode = !this.handleFrame(FrameTools.decode(chunk))

      if (!this.#isWSMode) {
        this.#connection!.close()
        break
      }
    }

    if (!this.#sentClosed) this.emit('close', null, null)
  }

  private handleFrame(frame: FrameInfo): boolean {
    switch (frame.op) {
      case '1':
        this.emit('textMessage', frame.content as string)
        break
      case '2':
        this.emit('binaryMessage', frame.content as Uint8Array)
        break
      case '8':
        // deno-lint-ignore no-explicit-any
        this.emit('close', (frame.content as any).code, (frame.content as any).content)
        this.#sentClosed = true
        return true
      case '9':
        this.pong()
        break
      case 'a':
        break
      default:
        this.emit('close', 1000, 'Server send invalid opcode')
        return true
    }
    return false
  }

  private async setConnection(promise: Promise<Deno.Conn>) {
    this.state = State.Connecting
    this.#connection = await promise.then(content => content)
  }

  private async upgradeAndListen(additionalHeaders: { [key: string]: string } = {}) {
    const headers = {
      'Host': this.url.host,
      'Upgrade': 'websocket',
      'Connection': 'upgrade',
      'Sec-WebSocket-Key': btoa((Math.random() + 1).toString(36).substring(0, 17)),
      'Sec-WebSocket-Version': 13,
      ...additionalHeaders
    }

    // Send raw HTTP GET request.
    const request = new TextEncoder().encode(
      `GET ${this.url.pathname} HTTP/1.1\r\n` + Object.entries(headers).map(([key, val]) => `${key}: ${val}`).join('\r\n') + '\r\n\r\n'
    )

    await this.#connection!.write(request)

    const buffer = new Uint8Array(1000)
    await this.#connection!.read(buffer)

    const out = new TextDecoder().decode(buffer).split('\r\n').filter(elt => elt.length > 0 && elt[0] !== '\x00')

    const isConnectionValid = out[0].split(' ')[1] == "101"

    if (!isConnectionValid) {
      console.error("Connection is invalid, check response headers below")
      console.error(out)
      return
    }

    this.#isWSMode = true
    this.state = State.Open
    this.emit('open')
  }

  /** Send ping frame */
  ping() {
    if (!this.#isWSMode) return
    this.#connection!.write(FrameTools.encode({
      fin: true,
      srv: [0, 0, 0],
      content: Uint8Array.from([]),
      length: Uint8Array.from([0]),
      mask: self.crypto.getRandomValues(new Uint8Array(4)),
      maskExists: true,
      op: '9'
    }))
  }

  /** Send pong frame (ping response) */
  pong() {
    if (!this.#isWSMode) return
    this.#connection!.write(FrameTools.encode({
      fin: true,
      srv: [0, 0, 0],
      content: Uint8Array.from([]),
      length: Uint8Array.from([0]),
      mask: self.crypto.getRandomValues(new Uint8Array(4)),
      maskExists: true,
      op: 'A'
    }))
  }

  /** Sends close packet effectively cutting off connection  */
  close(code: number | null, reason: string | undefined) {
    if (!this.#isWSMode) return

    if (code !== null && !this.isValidStatusCode(code)) {
      throw new Error('Invalid code')
    } else {
      code = 1000
    }

    if (reason === undefined) {
      reason = 'Connection closed'
    }


    const buffer = new ArrayBuffer(2)
    const dataView = new DataView(buffer)

    dataView.setUint16(0, code)

    // Create a Uint8Array from the buffer
    const decodedCode = new Uint8Array(buffer)

    this.#connection!.write(FrameTools.encode({
      fin: true,
      srv: [0, 0, 0],
      content: Uint8Array.from([...decodedCode, ...new TextEncoder().encode(reason)]),
      length: Uint8Array.from([reason.length + 2]),
      mask: self.crypto.getRandomValues(new Uint8Array(4)),
      maskExists: true,
      op: '8'
    }))

    this.#isWSMode = false
  }

  send(data: string | Uint8Array) {
    if (data.length < 126) {
      this.#connection!.write(FrameTools.encode({
        fin: true,
        srv: [0, 0, 0],
        content: data,
        length: Uint8Array.from([data.length]),
        mask: self.crypto.getRandomValues(new Uint8Array(4)),
        maskExists: true,
        op: Array.isArray(data) ? '2' : '1'
      }))

      return
    }

    if (data.length < (Math.pow(2, 16) - 1)) {
      if (!this.#isWSMode) return

      const buffer = new ArrayBuffer(2)
      const dataView = new DataView(buffer)

      dataView.setUint16(0, data.length)

      // Create a Uint8Array from the buffer
      const contentLength = new Uint8Array(buffer)

      this.#connection!.write(FrameTools.encode({
        fin: true,
        srv: [0, 0, 0],
        content: data,
        length: Uint8Array.from([126, ...contentLength]),
        mask: self.crypto.getRandomValues(new Uint8Array(4)),
        maskExists: true,
        op: Array.isArray(data) ? '2' : '1'
      }))

      return
    }

    if (data.length > (Math.pow(2, 64) - 1)) {

      const buffer = new ArrayBuffer(8)
      const dataView = new DataView(buffer)

      dataView.setUint32(0, data.length)
      dataView.setUint32(4, (data.length - dataView.getUint32(0)) / Math.pow(2, 32))

      // Create a Uint8Array from the buffer
      const contentLength = new Uint8Array(buffer)

      this.#connection!.write(FrameTools.encode({
        fin: true,
        srv: [0, 0, 0],
        content: data,
        length: Uint8Array.from([127, ...contentLength]),
        mask: self.crypto.getRandomValues(new Uint8Array(4)),
        maskExists: true,
        op: Array.isArray(data) ? '2' : '1'
      }))

      return
    } else {
      throw new Error('Not implemented')
    }
  }

  private isValidStatusCode(code: number) {
    return (
      (code >= 1000 &&
        code <= 1014 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006) ||
      (code >= 3000 && code <= 4999)
    )
  }
}