// Runs inside the iOS Simulator (via `xcrun simctl spawn`) and posts the same
// vendor-defined HID event that the hidden hinge slider in Xcode's Device Hub sends.
// It also reads the current angle back from CoreMotion.
//
//   hinge_helper set <degrees> [confirm-seconds]
//   hinge_helper sweep <from> <to> <seconds>
//   hinge_helper orient <portrait|landscape-left|landscape-right|pud>
//   hinge_helper get

#import <Foundation/Foundation.h>

#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef allocator, uint64_t timeStamp,
    uint32_t usagePage, uint32_t usage, uint32_t version, const uint8_t *data, CFIndex length, uint32_t options);
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef allocator, int type,
    CFDictionaryRef properties);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef client, IOHIDEventRef event);
extern CFDataRef IOCFSerialize(CFTypeRef object, CFOptionFlags options);

enum {
    kUsagePage = 0xFF61,
    kUsage = 0x5B,
    kClientTypeSimple = 4,
    kSerializeBinary = 1,
    kSweepHz = 60,
};

// The simulator does not check the provider name, but this is the one Device Hub
// sends for both the hinge slider and the orientation picker.
static CFStringRef const kProvider = CFSTR("com.apple.Virtualization.VirtualMachines");

// Seconds to wait for the first angle update before giving up.
static const CFTimeInterval kAngleTimeout = 2;
// How close a reported angle must be to count as the angle that was sent.
static const double kAngleTolerance = 0.5;
// The run loop runs in slices, so an update that lands before it starts is not missed.
static const CFTimeInterval kRunLoopSlice = 0.05;
// Time to let the last event leave before the process exits.
static const useconds_t kSettleMicros = 20000;

// CoreMotion's private angle API, the same source UIKit's UIHinge reads.
@interface CMAngle : NSObject
- (float)angleDegrees;
@end

@interface CMAngleManager : NSObject
+ (BOOL)isAvailable;
- (void)startAngleUpdatesToQueue:(NSOperationQueue *)queue handler:(void (^)(CMAngle *angle))handler;
- (void)stopAngleUpdates;
@end

typedef enum {
    kObserveUnavailable = -1,
    kObserveTimedOut = 0,
    kObserveAccepted = 1,
} ObserveResult;

// Serializes the payload and dispatches it as the vendor-defined event Device Hub uses.
static void send_payload(IOHIDEventSystemClientRef client, CFStringRef source, CFStringRef type, CFTypeRef value) {
    const void *keys[] = {CFSTR("provider"), CFSTR("source"), CFSTR("type"), CFSTR("value")};
    const void *values[] = {kProvider, source, type, value};
    CFDictionaryRef payload = CFDictionaryCreate(NULL, keys, values, 4,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDataRef data = IOCFSerialize(payload, kSerializeBinary);

    if (data) {
        IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), kUsagePage, kUsage, 0,
            CFDataGetBytePtr(data), CFDataGetLength(data), 0);
        if (event) {
            IOHIDEventSystemClientDispatchEvent(client, event);
            CFRelease(event);
        }
        CFRelease(data);
    }
    CFRelease(payload);
}

static double clamp_angle(double degrees) {
    if (degrees < 0) return 0;
    if (degrees > 180) return 180;
    return degrees;
}

static void send_angle(IOHIDEventSystemClientRef client, double degrees) {
    degrees = clamp_angle(degrees);
    CFNumberRef value = CFNumberCreate(NULL, kCFNumberDoubleType, &degrees);
    send_payload(client, CFSTR("hinge-slider-control"), CFSTR("range"), value);
    CFRelease(value);
}

// Same event as Device Hub's Controls > Rotate Left/Right, which sends the absolute target orientation.
static void send_orientation(IOHIDEventSystemClientRef client, const char *orientation) {
    CFStringRef value = CFStringCreateWithCString(NULL, orientation, kCFStringEncodingUTF8);
    send_payload(client, CFSTR("orientation-picker-control"), CFSTR("enum"), value);
    CFRelease(value);
}

// Starts angle updates, runs `afterStart`, then waits until `accept` takes an update
// or `timeout` passes. CoreMotion delivers the first update right away, without
// waiting for a change.
static ObserveResult observe_angles(CFTimeInterval timeout, void (^afterStart)(void), bool (^accept)(double degrees)) {
    Class managerClass = NSClassFromString(@"CMAngleManager");
    if (!managerClass || ![managerClass isAvailable]) {
        fprintf(stderr, "hinge_helper: this simulator reports no hinge\n");
        return kObserveUnavailable;
    }

    id manager = [[managerClass alloc] init];
    __block bool accepted = false;
    [manager startAngleUpdatesToQueue:[NSOperationQueue new] handler:^(CMAngle *angle) {
        if (!accepted && accept([angle angleDegrees])) accepted = true;
    }];
    if (afterStart) afterStart();

    CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout;
    while (!accepted && CFAbsoluteTimeGetCurrent() < deadline) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, kRunLoopSlice, false);
    }
    [manager stopAngleUpdates];
    return accepted ? kObserveAccepted : kObserveTimedOut;
}

static int print_angle(void) {
    __block double current = 0;
    ObserveResult result = observe_angles(kAngleTimeout, NULL, ^bool(double degrees) {
        current = degrees;
        return true;
    });
    if (result == kObserveTimedOut) fprintf(stderr, "hinge_helper: timed out reading the hinge angle\n");
    if (result != kObserveAccepted) return 1;
    printf("%.1f\n", current);
    return 0;
}

// Reuse transport startup, not a cached reading. Every request starts a fresh
// CoreMotion observation and waits for its initial sample.
static int serve_angles(void) {
    char *line = NULL;
    size_t capacity = 0;
    puts("READY"); fflush(stdout);
    while (getline(&line, &capacity, stdin) > 0) {
        if (strcmp(line, "get\n") != 0 || print_angle() != 0) puts("ERROR");
        fflush(stdout);
    }
    free(line);
    return 0;
}

// Read-only stream for serve-sim's native 3D pose monitor. First sample is
// emitted immediately; later samples follow actual CoreMotion changes.
static int watch_angles(void) {
    __block double previous = -1000;
    ObserveResult result = observe_angles(3600, NULL, ^bool(double degrees) {
        if (isfinite(degrees) && degrees >= 0 && degrees <= 180 && fabs(previous - degrees) >= kAngleTolerance) {
            previous = degrees;
            printf("AngleValid:Y Angle: %.1f°\n", degrees);
            fflush(stdout);
        }
        return false;
    });
    return result == kObserveUnavailable ? 1 : 0;
}

// Sends the angle and waits for CoreMotion to report it, so the caller knows the
// simulator took the change instead of only that the event was dispatched.
static int set_angle_confirmed(IOHIDEventSystemClientRef client, double degrees, CFTimeInterval timeout) {
    double target = clamp_angle(degrees);
    ObserveResult result = observe_angles(timeout, ^{
        send_angle(client, target);
    }, ^bool(double reported) {
        return fabs(reported - target) <= kAngleTolerance;
    });
    if (result == kObserveTimedOut) {
        fprintf(stderr, "hinge_helper: the hinge angle did not reach %.1f within %.1f s\n", target, timeout);
    }
    return result == kObserveAccepted ? 0 : 1;
}

static int usage(void) {
    fprintf(stderr, "usage: hinge_helper set <degrees> [confirm-seconds]\n"
                    "       hinge_helper sweep <from> <to> <seconds>\n"
                    "       hinge_helper orient <orientation>\n"
                    "       hinge_helper get|watch\n");
    return 64;
}

int main(int argc, char **argv) {
    if (argc < 2) return usage();
    if (strcmp(argv[1], "get") == 0 && argc == 2) return print_angle();
    if (strcmp(argv[1], "serve") == 0 && argc == 2) return serve_angles();
    if (strcmp(argv[1], "watch") == 0 && argc == 2) return watch_angles();
    if (argc < 3) return usage();

    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateWithType(NULL, kClientTypeSimple, NULL);
    if (!client) {
        fprintf(stderr, "hinge_helper: failed to create HID event system client\n");
        return 1;
    }

    if (strcmp(argv[1], "set") == 0 && argc <= 4) {
        // A confirm timeout above 0 waits for the angle to be reported back.
        double timeout = argc == 4 ? atof(argv[3]) : 0;
        if (timeout > 0) return set_angle_confirmed(client, atof(argv[2]), timeout);
        send_angle(client, atof(argv[2]));
    } else if (strcmp(argv[1], "orient") == 0 && argc == 3) {
        send_orientation(client, argv[2]);
    } else if (strcmp(argv[1], "sweep") == 0 && argc == 5) {
        double from = atof(argv[2]), to = atof(argv[3]), seconds = fmax(atof(argv[4]), 0);
        int steps = (int)fmax(1, round(seconds * kSweepHz));
        for (int i = 0; i <= steps; i++) {
            send_angle(client, from + (to - from) * i / steps);
            if (i < steps) usleep((useconds_t)(seconds * 1e6 / steps));
        }
    } else {
        return usage();
    }

    usleep(kSettleMicros);
    return 0;
}
