#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <unistd.h>

/* Self-spawn must re-enter the wrapper, not invoke ld.so with "serve". */
ssize_t readlink(const char *path, char *buffer, size_t size)
{
    ssize_t (*original)(const char *, char *, size_t) = dlsym(RTLD_NEXT, "readlink");
    ssize_t length = original(path, buffer, size);
    if (strcmp(path, "/proc/self/exe") == 0 &&
        length == (ssize_t) strlen(LOADER) && memcmp(buffer, LOADER, length) == 0) {
        size_t copied = strlen(WRAPPER);
        if (copied > size) copied = size;
        memcpy(buffer, WRAPPER, copied);
        return copied;
    }
    return length;
}
