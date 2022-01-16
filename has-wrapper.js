const { v4: uuidv4 } = require("uuid")
const CryptoJS = require("crypto-js")
const assert = require("assert")

const CMD = {
    CONNECTED:      "connected",
    AUTH_REQ:       "auth_req",
    AUTH_WAIT:      "auth_wait",
    AUTH_ACK:       "auth_ack",
    AUTH_NACK:      "auth_nack",
    AUTH_ERR:       "auth_err",
    SIGN_REQ:       "sign_req",
    SIGN_WAIT:      "sign_wait",
    SIGN_ACK:       "sign_ack",
    SIGN_NACK:      "sign_nack",
    SIGN_ERR:       "sign_err",
    CHALLENGE_REQ:  "challenge_req",
    CHALLENGE_WAIT: "challenge_wait",
    CHALLENGE_ACK:  "challenge_ack",
    CHALLENGE_NACK: "challenge_nack",
    CHALLENGE_ERR:  "challenge_err",
    ERROR:          "error"
}

const DELAY_CHECK_WEBSOCKET = 250                 // Delay between checking WebSocket connection (in milliseconds)
const DELAY_CHECK_REQUESTS = 250                  // Delay between checking HAS events (in milliseconds)
const HAS_SERVER = "wss://hive-auth.arcange.eu/"  // Default HAS infrastructure host

const HAS_PROTOCOL = 0.7
const HAS_options = {
  host: HAS_SERVER,
  auth_key_secret: undefined
}

let HAS_connected = false
let HAS_timeout = 60*1000 // default request expiration timeout - 60 seconds

let requests = []
let wsHAS = undefined
let trace = false

function getRequest(type, uuid=undefined) {
  // Clean expired requests
  requests = requests.filter(o => !o.expire || o.expire >= Date.now())
  // Search for first matching request
  const req = requests.find(o => o.cmd==type && (uuid ? o.uuid==uuid : true))
  // If any found, remove it from the array
  if(req) {
    requests = requests.filter(o => !(o.cmd==type && (uuid ? o.uuid==req.uuid : true)))
  }
  return req
}

// HAS client
function startWebsocket() {
  wsHAS = new WebSocket(HAS_SERVER)
  wsHAS.onopen = function() {
    // Web Socket is connected
    HAS_connected = true
    if(trace) console.log("WebSocket connected")
  }
  wsHAS.onmessage = function(event) { 
    if(trace) console.log(`[RECV] ${event.data}`)
    const message = typeof(event.data)=="string" ? JSON.parse(event.data) : event.data
    // Process HAS <-> App protocol
    if(message.cmd) {
      switch(message.cmd) {
        case CMD.CONNECTED:
          HAS_timeout = message.timeout * 1000
          if(message.protocol > HAS_PROTOCOL) {
            console.error("unsupported HAS protocol")
          }
          break
        case CMD.AUTH_WAIT:
        case CMD.AUTH_ACK:
        case CMD.AUTH_NACK:
        case CMD.AUTH_ERR:
        case CMD.SIGN_WAIT:
        case CMD.SIGN_ACK:
        case CMD.SIGN_NACK:
        case CMD.SIGN_ERR:
        case CMD.CHALLENGE_WAIT:
        case CMD.CHALLENGE_ACK:
        case CMD.CHALLENGE_NACK:
        case CMD.CHALLENGE_ERR:
        case CMD.ERROR:
          requests.push(message)
          break
        }
    }
  }
  wsHAS.onclose = function(event) {
    // connection closed, discard old websocket
    wsHAS = undefined
    HAS_connected = false
    if(trace) console.log("WebSocket disconnected", event)
  }
}

function send(message) {
  if(trace) console.log(`[SEND] ${message}`)
  wsHAS.send(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isConnected() {
  if ("WebSocket" in window) {
    // The browser support Websocket
    if(HAS_connected) {
      return true
    }
    startWebsocket()
    if(!HAS_connected) {
        do {
        await sleep(DELAY_CHECK_WEBSOCKET)
      } while(wsHAS && wsHAS.readyState==0) // 0 = Connecting
    }
    return HAS_connected
  } else {
    return false
  }
}

export class Auth {
    constructor(username, token=undefined, expire=undefined, key=undefined) {
      this.username = username
      this.token = token
      this.expire = expire
      this.key = key
    }
}

export default {
  setOptions: function(options) {
    assert(options.host===undefined || options.host.match("^((ws|wss)?:\/\/)"),"invalid host URL")
    assert(options.auth_key_secret===undefined ||  (typeof(options.auth_key_secret)=="string" && options.auth_key_secret!=""),"invalid auth_key_secret")
    if(options.host) {
      HAS_options.host = options.host
    }
    if(options.auth_key_secret) {
      console.warn("Warning: do not enable SendAuthKey unless you run your own PKSA in service mode!")
      HAS_options.auth_key_secret = options.auth_key_secret
    }
  },

  traceOn: function() {
    trace = true
  },
  traceOff: function() {
    trace = false
  },
  
  status: function() {
    return {host:HAS_options.host, connected:HAS_connected, timeout:HAS_timeout}
  },

  connect: async function() {
    return (await isConnected())
  },

  // auth is an object with the following properties:
  // - username: string (required)
  // - token: string (optional)
  // - key: string (optional)
  // app_data is an object with the following properties
  // - name: string (required)
  // - description: string (optional)
  // - icon: string (optional)
  // challenge_data is an (optional) object with the following properties
  // - key_type: string
  // - challenge: string
  // cbWait is an (optional) callback method to notify the app about pending request
  authenticate: function(auth, app_data, challenge_data=undefined, cbWait=undefined) {
    return new Promise(async (resolve,reject) => {
      assert(auth && auth.username && typeof(auth.username)=="string","missing or invalid auth.username")
      assert(app_data && app_data.name && typeof(app_data.name)=="string","missing or invalid app_data.name")
      assert(challenge_data && challenge_data.key_type && typeof(challenge_data.key_type)=="string","missing or invalid challenge_data.key_type")
      assert(challenge_data && challenge_data.challenge && typeof(challenge_data.challenge)=="string","missing or invalid challenge_data.challenge")
      assert((await isConnected()),"not connected to server")

      // initialize key to encrypt communication with PKSA
      const auth_key = auth.key || uuidv4()
      const data = CryptoJS.AES.encrypt(JSON.stringify({token:auth.token, app:app_data, challenge:challenge_data}),auth_key).toString()
      const payload = { cmd:CMD.AUTH_REQ, account:auth.username, token:auth.token, data:data}
      // NOTE:    In "service" mode, we can pass the encryption key to the PKSA with the auth_req to create and initialize an access token
      //          If the PKSA process the "auth_req", then it can bypass the offline reading of the encryption key
      if(HAS_options.auth_key_secret) {
        // Encrypt auth_key before sending it to the HAS
        payload.auth_key = CryptoJS.AES.encrypt(auth_key,HAS_options.auth_key_secret).toString()
      }

      send(JSON.stringify(payload))
      let expire = Date.now() + HAS_timeout
      let uuid = undefined
      const wait = setInterval(() => {
        if(!uuid) {
          const req = getRequest(CMD.AUTH_WAIT)
          if(req) {
            if(trace) console.log(`auth_wait found: ${JSON.stringify(req)}`)
            uuid = req.uuid
            expire = req.expire
            // provide the PKSA encryption key the App for it to build the auth_payload
            req.key = auth_key
            // call app back to notify about pending request and authentication payload
            if(cbWait) cbWait(req)
          }
        } else {
          const req_ack = getRequest(CMD.AUTH_ACK, uuid)
          const req_nack = getRequest(CMD.AUTH_NACK, uuid)
          const req_err = getRequest(CMD.AUTH_ERR, uuid)
          if(req_ack) {
              try{
                // Try to decrypt and parse payload data
                req_ack.data = JSON.parse(CryptoJS.AES.decrypt(req_ack.data, auth_key).toString(CryptoJS.enc.Utf8))
                // authentication approved
                clearInterval(wait)
                if(trace) console.log(`auth_ack found: ${JSON.stringify(req_ack)}`)
                // update credentials with PKSA token/expiration and PKSA enryption key
                auth.token = req_ack.data.token
                auth.expire = req_ack.data.expire
                auth.key = auth_key
                resolve(req_ack)
              } catch(e) {
                // Decryption failed - ignore message
              }
          } else if(req_nack) {
            // validate uuid
            if(uuid==CryptoJS.AES.decrypt(req_nack.data, auth_key).toString(CryptoJS.enc.Utf8)) {
              // authentication rejected
              reject(req_nack)
            }
          } else if(req_err) {
            // authentication error
            reject(req_err)
          }
        }
        // Check if authentication request has expired
        if(expire <= Date.now()) {
          clearInterval(wait)
          reject(new Error("expired"))
        }
      },DELAY_CHECK_REQUESTS)
    })
  },

  // auth is an object with the following properties:
  // - username: string (required)
  // - token: string (required)
  // - key: string (required)
  // cbWait is an (optional) callback method to notify the app about pending request
  broadcast: function(auth, key_type, ops, cbWait=undefined) {
    return new Promise(async (resolve,reject) => {
      assert(auth,"missing auth")
      assert(auth.username && typeof(auth.username)=="string","missing or invalid username")
      assert(auth.token && typeof(auth.token)=="string", "missing or invalid token")
      assert(auth.key && typeof(auth.key)=="string", "missing or invalid encryption key")
      assert(ops && Array.isArray(ops) && ops.length>0, "missing or invalid ops")
      assert((await isConnected()),"not connected to server")

      // Encrypt the ops with the key we provided to the PKSA
      const data = CryptoJS.AES.encrypt(JSON.stringify({key_type:key_type, ops:ops, broadcast:true}),auth.key).toString()
      // Send the sign request to the HAS
      const payload = { cmd:CMD.SIGN_REQ, account:auth.username, token:auth.token, data:data}
      send(JSON.stringify(payload))
      let expire = Date.now() + HAS_timeout
      let uuid = undefined
      // Wait for the confirmation by the HAS
      const wait = setInterval(() => {
        if(!uuid) {
          // We did not received the sign_wait confirmation yet from the HAS
          // check if we got one
          const req = getRequest(CMD.SIGN_WAIT)
          if(req) {
            // confirmation received
            if(trace) console.log(`sign_wait found: ${JSON.stringify(req)}`)
            uuid = req.uuid
            expire = req.expire
            // call back app to notify about pending request
            if(cbWait) cbWait(req)
          }
        } else {
          // Confirmation received, check if we got a request result
          const req_ack = getRequest(CMD.SIGN_ACK, uuid)
          const req_nack = getRequest(CMD.SIGN_NACK, uuid)
          const req_err = getRequest(CMD.SIGN_ERR, uuid)
          if(req_ack) {
            // request approved
            if(trace) console.log(`sign_ack found: ${JSON.stringify(req_ack)}`)
            clearInterval(wait)
            resolve(req_ack)
          } else if(req_nack) {
            // request rejected
            clearInterval(wait)
            reject(req_nack)
          } else if(req_err) {
            // request error
            clearInterval(wait)
            // Decrypt received error message
            const error = CryptoJS.AES.decrypt(req_err.error, auth.key).toString(CryptoJS.enc.Utf8)
            reject(new Error(error))
          }
        }
        // check if request expired
        if(expire <= Date.now()) {
          clearInterval(wait)
          reject(new Error("expired"))
        }
      },DELAY_CHECK_REQUESTS)
    })
  },
  // auth is an object with the following properties:
  // - username: string (required)
  // - token: string (required)
  // - key: string (required)
  // challenge_data is an object with the following properties
  // - key_type: string
  // - challenge: string
  // cbWait is an (optional) callback method to notify the app about pending request
  challenge: function(auth, challenge_data, cbWait=undefined) {
    return new Promise(async (resolve,reject) => {
      assert(auth,"missing auth")
      assert(auth.username && typeof(auth.username)=="string","missing or invalid username")
      assert(auth.token && typeof(auth.token)=="string", "missing or invalid token")
      assert(auth.key && typeof(auth.key)=="string", "missing or invalid encryption key")
      assert(challenge_data && challenge_data.key_type && typeof(challenge_data.key_type)=="string","missing or invalid challenge_data.key_type")
      assert(challenge_data && challenge_data.challenge && typeof(challenge_data.challenge)=="string","missing or invalid challenge_data.challenge")
      assert((await isConnected()),"not connected to server")
      // Encrypt the challenge data with the key we provided to the PKSA
      const data = CryptoJS.AES.encrypt(JSON.stringify(challenge_data),auth.key).toString()
      // Send the challenge request to the HAS
      const payload = { cmd:CMD.CHALLENGE_REQ, account:auth.username, token:auth.token, data:data}
      send(JSON.stringify(payload))
      let expire = Date.now() + HAS_timeout
      let uuid = undefined
      // Wait for the confirmation by the HAS
      const wait = setInterval(() => {
        if(!uuid) {
          // We did not received the challenge_wait confirmation yet from the HAS
          // check if we got one
          const req = getRequest(CMD.CHALLENGE_WAIT)
          if(req) {
            // confirmation received
            if(trace) console.log(`challenge_wait found: ${JSON.stringify(req)}`)
            uuid = req.uuid
            expire = req.expire
            // call back app to notify about pending request
            if(cbWait) cbWait(req)
          }
        } else {
          // Confirmation received, check if we got a request result
          const req_ack = getRequest(CMD.CHALLENGE_ACK, uuid)
          const req_nack = getRequest(CMD.CHALLENGE_NACK, uuid)
          const req_err = getRequest(CMD.CHALLENGE_ERR, uuid)
          if(req_ack) {
            // request approved
            try{
              // Try to decrypt and parse payload data
              req_ack.data = JSON.parse(CryptoJS.AES.decrypt(req_ack.data, auth.key).toString(CryptoJS.enc.Utf8))
              // challenge approved
              clearInterval(wait)
              if(trace) console.log(`challenge_ack found: ${JSON.stringify(req_ack)}`)
              resolve(req_ack)
            } catch(e) {
              // Decryption failed - ignore message
            }
          } else if(req_nack) {
            // request rejected
            clearInterval(wait)
            reject(req_nack)
          } else if(req_err) {
            // request error
            clearInterval(wait)
            // Decrypt received error message
            const error = CryptoJS.AES.decrypt(req_err.error, auth.key).toString(CryptoJS.enc.Utf8)
            reject(new Error(error))
          }
        }
        // check if request expired
        if(expire <= Date.now()) {
          clearInterval(wait)
          reject(new Error("expired"))
        }
      },DELAY_CHECK_REQUESTS)
    })
  },
}