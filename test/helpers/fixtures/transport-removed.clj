; initialize the archipelago
(configure)
(configureTransports [
     [1 6 0 3] 
  ])

; test case 1
(move ["1" 0 0 0]
      ["2" 16 0 16])
(ensureIslandsCount 1)
(expectIslandWith ["1" "2"])
(ensureIslandsCountWithTransport 1 1)

; transport 1 is removed
(removeTransports [1])
(move ["3" 16 0 16])
(ensureIslandsCount 2)
(ensureIslandsCountWithTransport 1 1)
(ensureIslandsCountWithTransport 1 0)
