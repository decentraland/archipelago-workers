build-proto: 
	mkdir -p "$(PWD)/src/controllers/proto" || true
	node_modules/.bin/protoc \
		--plugin=./node_modules/.bin/protoc-gen-ts_proto \
		--ts_proto_opt=esModuleInterop=true,returnObservable=false,outputServices=generic-definitions,oneof=unions \
		--ts_proto_out="$(PWD)/src/controllers/proto" \
		-I="$(PWD)/node_modules/@dcl/protocol/kernel/comms/v3" \
		"$(PWD)/node_modules/@dcl/protocol/kernel/comms/v3/archipelago.proto" 

	node_modules/.bin/protoc \
		--plugin=./node_modules/.bin/protoc-gen-ts_proto \
		--ts_proto_opt=esModuleInterop=true,returnObservable=false,outputServices=generic-definitions,oneof=unions \
		--ts_proto_out="$(PWD)/src/controllers/proto" \
		-I="$(PWD)/node_modules/protobufjs" \
		-I="$(PWD)/node_modules/@dcl/protocol" \
		-I="$(PWD)/node_modules/@dcl/protocol/bff" \
		"$(PWD)/node_modules/@dcl/protocol/bff/comms-director-service.proto"

build: build-proto
	npm run build

install:
	npm ci
