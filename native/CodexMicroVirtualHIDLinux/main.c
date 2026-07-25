#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uhid.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define REPORT_SIZE 64U
#define REPORT_ID 0x06U
#define DEFAULT_SOCKET_PATH "/tmp/codex-micro-vhid.sock"

static volatile sig_atomic_t running = 1;
static int uhid_fd = -1;
static int server_fd = -1;
static const char *active_socket_path = NULL;

static const uint8_t report_descriptor[] = {
    0x06, 0x00, 0xFF, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x06,
    0x09, 0x01, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08,
    0x95, 0x3F, 0x81, 0x02, 0x09, 0x01, 0x91, 0x02, 0xC0,
};

static void handle_signal(int signal_number) {
    (void)signal_number;
    running = 0;
}

static int write_all(int fd, const void *data, size_t size) {
    const uint8_t *cursor = data;
    while (size > 0) {
        ssize_t written = write(fd, cursor, size);
        if (written < 0) {
            if (errno == EINTR) continue;
            return -errno;
        }
        if (written == 0) return -EIO;
        cursor += (size_t)written;
        size -= (size_t)written;
    }
    return 0;
}

static int send_uhid_event(const struct uhid_event *event) {
    int result = write_all(uhid_fd, event, sizeof(*event));
    if (result < 0) {
        errno = -result;
        perror("write /dev/uhid");
    }
    return result;
}

static int create_device(void) {
    struct uhid_event event = {0};
    event.type = UHID_CREATE2;
    snprintf((char *)event.u.create2.name, sizeof(event.u.create2.name), "%s", "Codex Micro");
    snprintf((char *)event.u.create2.phys, sizeof(event.u.create2.phys), "%s", "codex-micro/virtual");
    event.u.create2.rd_size = sizeof(report_descriptor);
    memcpy(event.u.create2.rd_data, report_descriptor, sizeof(report_descriptor));
    event.u.create2.bus = BUS_USB;
    event.u.create2.vendor = 0x303A;
    event.u.create2.product = 0x8360;
    event.u.create2.version = 0x0100;
    event.u.create2.country = 0;
    return send_uhid_event(&event);
}

static void destroy_device(void) {
    if (uhid_fd < 0) return;
    struct uhid_event event = {0};
    event.type = UHID_DESTROY;
    (void)send_uhid_event(&event);
}

static int inject_input(const uint8_t frame[REPORT_SIZE]) {
    struct uhid_event event = {0};
    event.type = UHID_INPUT2;
    event.u.input2.size = REPORT_SIZE;
    memcpy(event.u.input2.data, frame, REPORT_SIZE);
    return send_uhid_event(&event);
}

static int forward_output(int client_fd, const uint8_t *data, size_t size) {
    uint8_t frame[REPORT_SIZE] = {0};
    size_t copy_size = size < REPORT_SIZE ? size : REPORT_SIZE;
    memcpy(frame, data, copy_size);
    if (copy_size == REPORT_SIZE - 1 && frame[0] != REPORT_ID) {
        memmove(frame + 1, frame, copy_size);
        frame[0] = REPORT_ID;
    }
    return write_all(client_fd, frame, sizeof(frame));
}

static int handle_uhid_event(int client_fd) {
    struct uhid_event event;
    ssize_t size;
    do {
        size = read(uhid_fd, &event, sizeof(event));
    } while (size < 0 && errno == EINTR);
    if (size < 0) return -errno;
    if ((size_t)size != sizeof(event)) return -EIO;

    switch (event.type) {
        case UHID_OUTPUT:
            return forward_output(client_fd, event.u.output.data, event.u.output.size);
        case UHID_SET_REPORT: {
            int result = forward_output(client_fd, event.u.set_report.data, event.u.set_report.size);
            struct uhid_event reply = {0};
            reply.type = UHID_SET_REPORT_REPLY;
            reply.u.set_report_reply.id = event.u.set_report.id;
            reply.u.set_report_reply.err = result < 0 ? (uint16_t)(-result) : 0;
            return send_uhid_event(&reply);
        }
        case UHID_GET_REPORT: {
            struct uhid_event reply = {0};
            reply.type = UHID_GET_REPORT_REPLY;
            reply.u.get_report_reply.id = event.u.get_report.id;
            reply.u.get_report_reply.err = EOPNOTSUPP;
            reply.u.get_report_reply.size = 0;
            return send_uhid_event(&reply);
        }
        default:
            return 0;
    }
}

static int parse_id(const char *value, uid_t *id) {
    if (!value || !*value) return -1;
    char *end = NULL;
    errno = 0;
    unsigned long parsed = strtoul(value, &end, 10);
    if (errno || *end != '\0' || parsed > UINT32_MAX) return -1;
    *id = (uid_t)parsed;
    return 0;
}

static int make_socket(const char *path) {
    struct sockaddr_un address = {0};
    if (strlen(path) >= sizeof(address.sun_path)) {
        fprintf(stderr, "Socket path is too long: %s\n", path);
        return -ENAMETOOLONG;
    }

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -errno;
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, path, strlen(path) + 1);
    unlink(path);

    mode_t old_mask = umask(0077);
    int result = bind(fd, (struct sockaddr *)&address, sizeof(address));
    umask(old_mask);
    if (result < 0) {
        result = -errno;
        close(fd);
        return result;
    }

    uid_t sudo_uid;
    uid_t sudo_gid;
    if (parse_id(getenv("SUDO_UID"), &sudo_uid) == 0 && parse_id(getenv("SUDO_GID"), &sudo_gid) == 0) {
        if (chown(path, sudo_uid, (gid_t)sudo_gid) < 0) {
            result = -errno;
            unlink(path);
            close(fd);
            return result;
        }
    }
    if (chmod(path, 0600) < 0 || listen(fd, 1) < 0) {
        result = -errno;
        unlink(path);
        close(fd);
        return result;
    }
    return fd;
}

static int serve_client(int client_fd) {
    uint8_t socket_buffer[REPORT_SIZE * 16];
    size_t buffered = 0;

    while (running) {
        struct pollfd fds[] = {
            {.fd = uhid_fd, .events = POLLIN},
            {.fd = client_fd, .events = POLLIN},
        };
        int ready = poll(fds, 2, 500);
        if (ready < 0) {
            if (errno == EINTR) continue;
            return -errno;
        }
        if (ready == 0) continue;

        if (fds[0].revents & POLLIN) {
            int result = handle_uhid_event(client_fd);
            if (result < 0) return result;
        }
        if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) return -EIO;

        if (fds[1].revents & POLLIN) {
            ssize_t size = read(client_fd, socket_buffer + buffered, sizeof(socket_buffer) - buffered);
            if (size < 0) {
                if (errno == EINTR) continue;
                return -errno;
            }
            if (size == 0) return 0;
            buffered += (size_t)size;
            while (buffered >= REPORT_SIZE) {
                int result = inject_input(socket_buffer);
                if (result < 0) return result;
                buffered -= REPORT_SIZE;
                memmove(socket_buffer, socket_buffer + REPORT_SIZE, buffered);
            }
        }
        if (fds[1].revents & (POLLERR | POLLHUP | POLLNVAL)) return 0;
    }
    return 0;
}

static void cleanup(void) {
    destroy_device();
    if (server_fd >= 0) close(server_fd);
    if (uhid_fd >= 0) close(uhid_fd);
    if (active_socket_path) unlink(active_socket_path);
}

int main(int argc, char **argv) {
    const char *socket_path = argc > 1 ? argv[1] : DEFAULT_SOCKET_PATH;
    if (argc > 2) {
        fprintf(stderr, "Usage: %s [socket-path]\n", argv[0]);
        return EXIT_FAILURE;
    }

    struct sigaction action = {0};
    action.sa_handler = handle_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    atexit(cleanup);

    uhid_fd = open("/dev/uhid", O_RDWR | O_CLOEXEC);
    if (uhid_fd < 0) {
        fprintf(stderr, "Cannot open /dev/uhid: %s\n", strerror(errno));
        fprintf(stderr, "Load the module with `sudo modprobe uhid`, then run this helper with sudo.\n");
        return EXIT_FAILURE;
    }
    if (create_device() < 0) return EXIT_FAILURE;

    server_fd = make_socket(socket_path);
    if (server_fd < 0) {
        errno = -server_fd;
        fprintf(stderr, "Cannot listen on %s: %s\n", socket_path, strerror(errno));
        return EXIT_FAILURE;
    }
    active_socket_path = socket_path;
    fprintf(stderr, "Virtual Codex Micro created (VID 0x303A / PID 0x8360).\n");
    fprintf(stderr, "Listening on %s\n", socket_path);

    while (running) {
        int client_fd = accept4(server_fd, NULL, NULL, SOCK_CLOEXEC);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            perror("accept");
            return EXIT_FAILURE;
        }
        fprintf(stderr, "Bridge connected.\n");
        int result = serve_client(client_fd);
        close(client_fd);
        fprintf(stderr, "Bridge disconnected.\n");
        if (result < 0 && result != -ECONNRESET && result != -EPIPE) {
            errno = -result;
            perror("bridge");
        }
    }
    return EXIT_SUCCESS;
}
