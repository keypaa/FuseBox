#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int main(int argc, char *argv[]) {
    int i;
    for (i = 0; i < argc; i++) {
        dprintf(1, "argv[%d] = %s\n", i, argv[i]);
    }
    dprintf(1, "TEST INIT: Hello from test_init!\n");

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        dprintf(2, "FAIL: socket() = %d\n", fd);
        return 1;
    }
    dprintf(1, "OK: socket() = %d\n", fd);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(2025);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        dprintf(2, "FAIL: bind()\n");
        return 1;
    }
    dprintf(1, "OK: bind() port 2025\n");

    if (listen(fd, 1) < 0) {
        dprintf(2, "FAIL: listen()\n");
        return 1;
    }
    dprintf(1, "OK: listen()\n");

    dprintf(1, "TEST INIT: All OK, sleeping 10s...\n");
    sleep(10);
    dprintf(1, "TEST INIT: Exiting cleanly.\n");
    return 0;
}
