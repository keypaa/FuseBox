.PHONY: all kernel process-api initrd rootfs skills proxy network launch publish-rootfs clean

all: process-api kernel initrd rootfs skills proxy

process-api:
	cd process_api && cargo build --release --target x86_64-unknown-linux-musl

kernel:
	cd kernel && ./build-kernel.sh

initrd: process-api
	cd initrd && ./build-initrd.sh

rootfs:
	cd rootfs && sudo ./build-rootfs.sh

skills:
	cd skills && ./extract-skills.sh && ./build-skills.sh

proxy:
	cd proxy && ./generate-ca.sh
	cd proxy/sds-server && go build -o sds-server .

network:
	cd network && sudo ./setup-tap.sh

launch: all network
	$(MAKE) -C firecracker launch

publish-rootfs: rootfs
	cd rootfs && sg docker -c "docker push ghcr.io/keypaa/fusebox-rootfs:latest"

clean:
	rm -f kernel/vmlinux kernel/build/
	rm -f initrd/initrd.img
	rm -f rootfs/rootfs.ext4
	rm -f skills/*.squashfs
	rm -rf certs/
	cd network && sudo ./teardown-tap.sh 2>/dev/null || true
