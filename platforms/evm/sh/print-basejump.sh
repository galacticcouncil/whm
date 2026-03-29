# TO-DO: Verification script, drop after migration deployment

MOONBEAM=https://rpc.api.moonbeam.network
BASE=https://mainnet.base.org

BASEJUMP=0x73bab4cec782e1530117932cef8492ebe64e112e
BASEJUMP_PROXY=0x54c8ff9230627ed7bd5d7704f60018e47f36f233
TRANSACTOR=0x8db129af6423bda0896200bea3274cb498065515

echo "=== BasejumpProxy (Moonbeam) === $BASEJUMP_PROXY"

IP_OWNER=$(cast call $BASEJUMP_PROXY "owner()(address)" --rpc-url $MOONBEAM)
IP_EMITTER=$(cast call $BASEJUMP_PROXY "authorizedEmitters(uint16)(bytes32)" 30 --rpc-url $MOONBEAM)
IP_TRANSACTOR=$(cast call $BASEJUMP_PROXY "xcmTransactor()(address)" --rpc-url $MOONBEAM)
IP_TRANSFER=$(cast call $BASEJUMP_PROXY "basejumpLandings(uint16)(bytes32)" 16 --rpc-url $MOONBEAM)

echo "owner: $IP_OWNER"
echo "authorized emitter: $IP_EMITTER"
echo "xcm transactor: $IP_TRANSACTOR"
echo "basejump landing: $IP_TRANSFER"

echo "=== XcmTransactor (Moonbeam) === $TRANSACTOR"

XT_OWNER=$(cast call $TRANSACTOR "owner()(address)" --rpc-url $MOONBEAM)
XT_AUTHORIZED=$(cast call $TRANSACTOR "authorized(address)(bool)" $XT_OWNER --rpc-url $MOONBEAM)
XT_XCM_SOURCE=$(cast call $TRANSACTOR "xcmSource()(address)" --rpc-url $MOONBEAM)
XT_DISPATCHER=$(cast call $TRANSACTOR "authorizedDispatchers(address)(bool)" $IP_OWNER --rpc-url $MOONBEAM)

echo "owner: $XT_OWNER"
echo "authorized: $XT_AUTHORIZED"
echo "xcm source: $XT_XCM_SOURCE"
echo "authorized dispatcher: $XT_DISPATCHER"

echo "=== Basejump (Base) === $BASEJUMP"

IB_OWNER=$(cast call $BASEJUMP "owner()(address)" --rpc-url $BASE)
IB_EMITTER=$(cast call $BASEJUMP "authorizedEmitters(uint16)(bytes32)" 16 --rpc-url $BASE)
IB_TRANSFER=$(cast call $BASEJUMP "basejumpLandings(uint16)(bytes32)" 16 --rpc-url $BASE)

echo "owner: $IB_OWNER"
echo "authorized emitter: $IB_EMITTER"
echo "basejump landing: $IB_TRANSFER"
