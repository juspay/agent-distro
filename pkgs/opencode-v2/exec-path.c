/* Bun's payload trailer forbids patchelf, so Linux uses an explicit loader.
 * That loader becomes /proc/self/exe instead of the OpenCode executable.
 * selfCommand() spawns process.execPath, which must re-enter our wrapper. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((constructor))
static void remove_own_preload(void)
{
    const char *preload = getenv("LD_PRELOAD");
    if (!preload) return;
    char *entries = strdup(preload);
    char *remaining = malloc(strlen(preload) + 1);
    if (!entries || !remaining) {
        free(entries);
        free(remaining);
        return;
    }
    size_t length = 0;
    char *state;
    for (char *entry = strtok_r(entries, ": \t\n", &state); entry;
         entry = strtok_r(NULL, ": \t\n", &state)) {
        if (strcmp(entry, SHIM) == 0) continue;
        if (length) remaining[length++] = ':';
        size_t size = strlen(entry);
        memcpy(remaining + length, entry, size);
        length += size;
    }
    remaining[length] = '\0';
    if (length) setenv("LD_PRELOAD", remaining, 1);
    else unsetenv("LD_PRELOAD");
    free(entries);
    free(remaining);
}

static ssize_t redirect(const char *path, char *buffer, size_t size, ssize_t length)
{
    if (length == (ssize_t) strlen(LOADER) &&
        strcmp(path, "/proc/self/exe") == 0 && memcmp(buffer, LOADER, length) == 0) {
        size_t copied = strlen(WRAPPER);
        if (copied > size) copied = size;
        memcpy(buffer, WRAPPER, copied);
        return copied;
    }
    return length;
}

ssize_t readlink(const char *path, char *buffer, size_t size)
{
    ssize_t (*original)(const char *, char *, size_t) = dlsym(RTLD_NEXT, "readlink");
    return redirect(path, buffer, size, original(path, buffer, size));
}

ssize_t readlinkat(int fd, const char *path, char *buffer, size_t size)
{
    ssize_t (*original)(int, const char *, char *, size_t) = dlsym(RTLD_NEXT, "readlinkat");
    ssize_t length = original(fd, path, buffer, size);
    return fd == AT_FDCWD ? redirect(path, buffer, size, length) : length;
}
