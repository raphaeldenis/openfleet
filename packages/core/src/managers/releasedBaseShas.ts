// A shipped version is immutable: managers already read it by (version, sha). A body change means a new version
// and a new line here; editing a line below means a shipped version was edited, which is never allowed.
export const RELEASED_BASE_SHAS: Record<number, string> = {
  1: '4ee6ed1d031e912d825972627a8e759ea881218bcd33f4f9609e6c066daa56a6',
  2: 'fe4afd8ff81625b6ff76711c059222f817472fe3c2a4f6e0daa291c13a7a077c',
  3: '0ecc04887dbd48ab066dfe6b2fe23c583213e7ac582cff8e7db82781a7906607',
  4: 'e5e32b25404777c5885746f8d460bedf2aa89b0887c41ae928487285aa73cdb2',
  5: '6a4f96f827efa9ac37ee928ec35f460fdd8150811895c5a4bcf970afb077385d',
  6: 'e0275aa03e15cd99ddcf031faa05f05b66f736a018a8c26a8f974f9d0707228e',
  7: 'fce2b8993c2820b20b9b752f963637d2165510b8b9db76b970fa07a167fb61b8',
};
