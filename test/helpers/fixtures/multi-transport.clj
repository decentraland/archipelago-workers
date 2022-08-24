; initialize the archipelago
(configure)
(configureTransports [
     [1 6 0 3] 
  ])

(move ["1" 0 0 0]
      ["2" 16 0 16]
      ["3" 16 0 16])
(ensureIslandsCount 1)
(expectIslandWith ["1" "2" "3"])
(ensureIslandsCountWithTransport 1 1)

(configureTransports [
     [1 3 3 3] 
  ])

; the new peer should go to a new island since transport max peers is 3
(move ["4" 16 0 16])
(ensureIslandsCount 2)
(expectIslandWith ["1" "2" "3"])
(expectIslandWith ["4"])
(ensureIslandsCountWithTransport 2 1)


(configureTransports [
     [1 2 4 3] 
  ])

; a new peer far from the others, should go to another island, but it should also
; use p2p transport, since although there are seats left, they are reserved
(move ["far-peer" 160 0 160])
(expectIslandWith ["1" "2" "3"])
(expectIslandWith ["far-peer"])
(ensureIslandsCountWithTransport 2 1)
(ensureIslandsCountWithTransport 1 0)
  
; the new peers should go to the last island with transport 1
(move ["5" 16 0 16]
      ["6" 16 0 16])
(expectIslandWith ["1" "2" "3"])
(expectIslandWith ["4" "5" "6"])
(ensureIslandsCountWithTransport 2 1)
(ensureIslandsCountWithTransport 1 0)

(configureTransports [
     [1 0 6 3] 
  ])

; a new island is created, but there are no seats left in the transport/island
(move ["7" 16 0 16])
(expectIslandWith ["1" "2" "3"])
(expectIslandWith ["4" "5" "6"])
(expectIslandWith ["7"])
(ensureIslandsCountWithTransport 2 1)
(ensureIslandsCountWithTransport 2 0)
