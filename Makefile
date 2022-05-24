protoc3/bin/protoc:
	@# remove local folder
	rm -rf protoc3 || true

	@# Make sure you grab the latest version
	curl -OL https://github.com/protocolbuffers/protobuf/releases/download/v$(PROTOBUF_VERSION)/$(PROTOBUF_ZIP)

	@# Unzip
	unzip $(PROTOBUF_ZIP) -d protoc3
	@# delete the files
	rm $(PROTOBUF_ZIP)

	@# move protoc to /usr/local/bin/
	chmod +x protoc3/bin/protoc

build-proto: protoc3/bin/protoc
	protoc3/bin/protoc \
		--plugin=./node_modules/.bin/protoc-gen-ts_proto \
		--ts_proto_opt=esModuleInterop=true,oneof=unions \
		--ts_proto_out="$(PWD)/packages/shared/comms/v4/proto" \
		-I="$(PWD)/packages/shared/comms/v4/proto" \
		"$(PWD)/packages/shared/comms/v4/proto/comms.proto"  \
		"$(PWD)/packages/shared/comms/v4/proto/archipelago.proto" 

build: build-proto
	npm run build
