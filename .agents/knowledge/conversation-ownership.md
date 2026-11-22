# conversation-ownership

Which node may write a conversation when nodes disagree about who owns it.

## r-Run8Own

The node actually running a conversation must win an ownership conflict automatically: it takes ownership at the next epoch without asking the person. Only when both nodes are running it is the conflict left for the person to settle.

Evidence: a run on the Mac stayed fenced behind an "Owned by another node" banner on 2026-11-22 while 16 conversations sat in `conflict` on the homeserver; the user said a running conversation should get ownership in such cases · Added 2026-11-22
