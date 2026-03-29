# TO-DO: Verification script, drop after migration deployment

MOONBEAM=https://rpc.api.moonbeam.network
BASE=https://mainnet.base.org

IBRI_BASE=0x73bab4cec782e1530117932cef8492ebe64e112e
IBRI_PROXY=0x54c8ff9230627ed7bd5d7704f60018e47f36f233
TRANSACTOR=0x8db129af6423bda0896200bea3274cb498065515

echo "=== InstaBridgeProxy (Moonbeam) === $IBRI_PROXY"

IP_OWNER=$(cast call $IBRI_PROXY "owner()(address)" --rpc-url $MOONBEAM)
IP_EMITTER=$(cast call $IBRI_PROXY "authorizedEmitters(uint16)(bytes32)" 30 --rpc-url $MOONBEAM)
IP_TRANSACTOR=$(cast call $IBRI_PROXY "xcmTransactor()(address)" --rpc-url $MOONBEAM)
IP_TRANSFER=$(cast call $IBRI_PROXY "instaTransfers(uint16)(bytes32)" 16 --rpc-url $MOONBEAM)

echo "owner: $IP_OWNER"
echo "authorized emitter: $IP_EMITTER"
echo "xcm transactor: $IP_TRANSACTOR"
echo "insta transfer: $IP_TRANSFER"

echo "=== XcmTransactor (Moonbeam) === $TRANSACTOR"

XT_OWNER=$(cast call $TRANSACTOR "owner()(address)" --rpc-url $MOONBEAM)
XT_AUTHORIZED=$(cast call $TRANSACTOR "authorized(address)(bool)" $XT_OWNER --rpc-url $MOONBEAM)
XT_XCM_SOURCE=$(cast call $TRANSACTOR "xcmSource()(address)" --rpc-url $MOONBEAM)
XT_DISPATCHER=$(cast call $TRANSACTOR "authorizedDispatchers(address)(bool)" $IP_OWNER --rpc-url $MOONBEAM)

echo "owner: $XT_OWNER"
echo "authorized: $XT_AUTHORIZED"
echo "xcm source: $XT_XCM_SOURCE"
echo "authorized dispatcher: $XT_DISPATCHER"

echo "=== InstaBridge (Base) === $IBRI_BASE"

IB_OWNER=$(cast call $IBRI_BASE "owner()(address)" --rpc-url $BASE)
IB_EMITTER=$(cast call $IBRI_BASE "authorizedEmitters(uint16)(bytes32)" 16 --rpc-url $BASE)
IB_TRANSFER=$(cast call $IBRI_BASE "instaTransfers(uint16)(bytes32)" 16 --rpc-url $BASE)

echo "owner: $IB_OWNER"
echo "authorized emitter: $IB_EMITTER"
echo "insta transfer: $IB_TRANSFER"
