# TO-DO: Verification script, drop after migration deployment

MOONBEAM=https://rpc.api.moonbeam.network

DISPATCHER=0x27afd50e83379a53458446e9d5f4a557b5f55c19
TRANSACTOR=0xd1dc3517732c98502b5c1ba2389aca9e9016d89a

PRIME=0x26759f460ee5f743ed66d27c8f2a5623bf39d53ed575955320661e6e13e0e3da

echo "=== MessageDispatcher (Moonbeam) === $DISPATCHER"

MD_OWNER=$(cast call $DISPATCHER "owner()(address)" --rpc-url $MOONBEAM)
MD_EMITTER=$(cast call $DISPATCHER "authorizedEmitters(uint16)(bytes32)" 1 --rpc-url $MOONBEAM)
MD_HANDLER=$(cast call $DISPATCHER "handlers(uint8)(address)" 1 --rpc-url $MOONBEAM)
MD_ORACLE=$(cast call $DISPATCHER "oracles(bytes32)(address)" $PRIME --rpc-url $MOONBEAM)

echo "owner: $MD_OWNER"
echo "authorized emitter: $MD_EMITTER"
echo "handler (action 1): $MD_HANDLER"
echo "oracle: $MD_ORACLE"

echo "=== XcmTransactor (Moonbeam) === $TRANSACTOR"

XT_OWNER=$(cast call $TRANSACTOR "owner()(address)" --rpc-url $MOONBEAM)
XT_AUTHORIZED=$(cast call $TRANSACTOR "authorized(address)(bool)" $XT_OWNER --rpc-url $MOONBEAM)
XT_XCM_SOURCE=$(cast call $TRANSACTOR "xcmSource()(address)" --rpc-url $MOONBEAM)
XT_DISPATCHER=$(cast call $TRANSACTOR "authorizedDispatchers(address)(bool)" $DISPATCHER --rpc-url $MOONBEAM)

echo "owner: $XT_OWNER"
echo "authorized: $XT_AUTHORIZED"
echo "xcm source: $XT_XCM_SOURCE"
echo "authorized dispatcher: $XT_DISPATCHER"
