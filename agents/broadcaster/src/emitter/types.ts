/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/message_emitter.json`.
 */
export type MessageEmitter = {
  "address": "8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz",
  "metadata": {
    "name": "messageEmitter",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "registerPoolFeed",
      "discriminator": [
        65,
        105,
        241,
        97,
        83,
        107,
        121,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "stakePoolFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "assetId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assetId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "stakePool",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "registerPriceFeed",
      "discriminator": [
        18,
        130,
        99,
        48,
        173,
        153,
        230,
        220
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "priceFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101,
                  95,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "assetId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "assetId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "priceIndex",
          "type": "u16"
        },
        {
          "name": "scopePrices",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "sendPrice",
      "discriminator": [
        53,
        172,
        65,
        183,
        30,
        133,
        37,
        111
      ],
      "accounts": [
        {
          "name": "priceFeed",
          "docs": [
            "Owner-registered binding: asset_id <-> oracle indexes."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101,
                  95,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "price_feed.asset_id",
                "account": "priceFeed"
              }
            ]
          }
        },
        {
          "name": "scopePrices"
        },
        {
          "name": "wormhole",
          "accounts": [
            {
              "name": "payer",
              "writable": true,
              "signer": true
            },
            {
              "name": "wormholePostMessageShim",
              "address": "EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX"
            },
            {
              "name": "bridge",
              "writable": true,
              "address": "2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn"
            },
            {
              "name": "message",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "emitter"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    206,
                    93,
                    34,
                    116,
                    131,
                    143,
                    202,
                    41,
                    198,
                    209,
                    143,
                    152,
                    10,
                    211,
                    213,
                    245,
                    235,
                    78,
                    129,
                    210,
                    121,
                    29,
                    243,
                    98,
                    128,
                    136,
                    144,
                    147,
                    38,
                    68,
                    208,
                    24
                  ]
                }
              }
            },
            {
              "name": "emitter",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      101,
                      109,
                      105,
                      116,
                      116,
                      101,
                      114
                    ]
                  }
                ]
              }
            },
            {
              "name": "sequence",
              "writable": true
            },
            {
              "name": "feeCollector",
              "writable": true,
              "address": "9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy"
            },
            {
              "name": "clock",
              "address": "SysvarC1ock11111111111111111111111111111111"
            },
            {
              "name": "systemProgram",
              "address": "11111111111111111111111111111111"
            },
            {
              "name": "wormholeProgram",
              "address": "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth"
            },
            {
              "name": "wormholePostMessageShimEa"
            }
          ]
        }
      ],
      "args": []
    },
    {
      "name": "sendRate",
      "discriminator": [
        40,
        41,
        129,
        253,
        162,
        155,
        233,
        218
      ],
      "accounts": [
        {
          "name": "stakePoolFeed",
          "docs": [
            "Owner-registered binding: asset_id <-> stake pool."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  112,
                  111,
                  111,
                  108,
                  95,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "stake_pool_feed.asset_id",
                "account": "stakePoolFeed"
              }
            ]
          }
        },
        {
          "name": "stakePool"
        },
        {
          "name": "wormhole",
          "accounts": [
            {
              "name": "payer",
              "writable": true,
              "signer": true
            },
            {
              "name": "wormholePostMessageShim",
              "address": "EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX"
            },
            {
              "name": "bridge",
              "writable": true,
              "address": "2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn"
            },
            {
              "name": "message",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "emitter"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    206,
                    93,
                    34,
                    116,
                    131,
                    143,
                    202,
                    41,
                    198,
                    209,
                    143,
                    152,
                    10,
                    211,
                    213,
                    245,
                    235,
                    78,
                    129,
                    210,
                    121,
                    29,
                    243,
                    98,
                    128,
                    136,
                    144,
                    147,
                    38,
                    68,
                    208,
                    24
                  ]
                }
              }
            },
            {
              "name": "emitter",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      101,
                      109,
                      105,
                      116,
                      116,
                      101,
                      114
                    ]
                  }
                ]
              }
            },
            {
              "name": "sequence",
              "writable": true
            },
            {
              "name": "feeCollector",
              "writable": true,
              "address": "9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy"
            },
            {
              "name": "clock",
              "address": "SysvarC1ock11111111111111111111111111111111"
            },
            {
              "name": "systemProgram",
              "address": "11111111111111111111111111111111"
            },
            {
              "name": "wormholeProgram",
              "address": "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth"
            },
            {
              "name": "wormholePostMessageShimEa"
            }
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "priceFeed",
      "discriminator": [
        189,
        103,
        252,
        23,
        152,
        35,
        243,
        156
      ]
    },
    {
      "name": "stakePoolFeed",
      "discriminator": [
        55,
        185,
        108,
        120,
        25,
        141,
        201,
        34
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidData",
      "msg": "Stake pool account data too short"
    },
    {
      "code": 6001,
      "name": "zeroSupply",
      "msg": "Stake pool total lamports is zero"
    },
    {
      "code": 6002,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "priceFeed",
      "docs": [
        "Owner-created binding between an oracle index, scope oracle account, and an asset identity.",
        "Seeds: [b\"price_feed\", asset_id]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceIndex",
            "type": "u16"
          },
          {
            "name": "scopePrices",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "stakePoolFeed",
      "docs": [
        "Owner-created binding between a stake pool and an asset identity.",
        "Seeds: [b\"stake_pool_feed\", asset_id]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "assetId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stakePool",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
