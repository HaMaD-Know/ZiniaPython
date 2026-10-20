//
//  ZPInterpreter.h
//  ZiniaPython
//
//  Objective-C host for the embedded CPython interpreter.
//
//  CPython is initialised once per process on a dedicated thread (which
//  therefore becomes Python's "main thread": signal handlers, and so the Stop
//  button, work there). Every request is a JSON string handed to
//  zinia.bridge.handle() on that thread; requests run strictly one at a time.
//
//  This header deliberately does not include Python.h, so Swift never has to
//  import CPython's C headers. Swift names are fixed with NS_SWIFT_NAME.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const ZPErrorDomain;

typedef NS_ENUM(NSInteger, ZPErrorCode) {
    ZPErrorCodeFrameworkMissing = 1,   // Python.framework is not loaded into the process
    ZPErrorCodeStdlibMissing = 2,      // python/lib/python3.X is missing from the bundle
    ZPErrorCodeSupportMissing = 3,     // python-app/zinia (ZiniaPython's runtime package) is missing
    ZPErrorCodePreInitFailed = 4,      // Py_PreInitialize failed
    ZPErrorCodeInitFailed = 5,         // Py_InitializeFromConfig failed
    ZPErrorCodeBridgeImportFailed = 6, // "import zinia.bridge" raised
    ZPErrorCodeBridgeInitFailed = 7,   // zinia.bridge.initialize() reported an error
    ZPErrorCodeAlreadyFailed = 8,      // an earlier start attempt failed after CPython was touched
};

typedef NS_ENUM(NSInteger, ZPOutputStream) {
    ZPOutputStreamStdout = 1,
    ZPOutputStreamStderr = 2,
    ZPOutputStreamSystem = 3,
};

/// Callbacks from the interpreter thread. Implementations must return quickly
/// and must not call back into ZPInterpreter synchronously.
@protocol ZPInterpreterDelegate <NSObject>
- (void)interpreterDidEmitOutput:(NSString *)text
                          stream:(ZPOutputStream)stream
                     executionId:(NSString *)executionId
    NS_SWIFT_NAME(interpreterDidEmitOutput(_:stream:executionId:));
- (void)interpreterDidEmitEvent:(NSString *)name payloadJSON:(NSString *)payloadJSON
    NS_SWIFT_NAME(interpreterDidEmitEvent(_:payloadJSON:));
/// Called right before the interpreter thread blocks waiting for input().
- (void)interpreterWillWaitForInputForExecution:(NSString *)executionId
    NS_SWIFT_NAME(interpreterWillWaitForInput(executionId:));
@end

typedef NS_ENUM(NSInteger, ZPInterpreterState) {
    ZPInterpreterStateNotStarted = 0,
    ZPInterpreterStateStarting = 1,
    ZPInterpreterStateReady = 2,
    ZPInterpreterStateFailed = 3,
};

@interface ZPInterpreter : NSObject

@property (class, nonatomic, readonly, strong) ZPInterpreter *shared;

@property (atomic, weak, nullable) id<ZPInterpreterDelegate> delegate;
@property (atomic, readonly) ZPInterpreterState state;
/// The execution currently running Python code, if any.
@property (atomic, readonly, copy, nullable) NSString *activeExecutionId;
/// The Python version the app was compiled against, e.g. "3.14.8".
@property (class, nonatomic, readonly) NSString *compiledPythonVersion;
/// "python3.14" - the name of the standard-library folder inside the bundle.
@property (class, nonatomic, readonly) NSString *stdlibFolderName;
/// Bytes the process may still allocate before iOS terminates it.
@property (class, nonatomic, readonly) uint64_t availableMemory;

/// Checks that the bundle contains everything CPython needs, without
/// touching the interpreter. Returns nil when the layout is complete.
+ (nullable NSError *)validateBundleLayoutAtResourcePath:(NSString *)resourcePath
    NS_SWIFT_NAME(validateBundleLayout(resourcePath:));

/// Starts CPython (once). `configuration` is passed as JSON to
/// zinia.bridge.initialize(). The completion runs on an arbitrary thread.
- (void)startWithResourcePath:(NSString *)resourcePath
                configuration:(NSDictionary<NSString *, id> *)configuration
                   completion:(void (^)(NSString *_Nullable runtimeInfoJSON, NSError *_Nullable error))completion
    NS_SWIFT_NAME(start(resourcePath:configuration:completion:));

/// Queues a JSON request for zinia.bridge.handle(). Requests run one at a
/// time, in order. `executionId` marks the request as interruptible.
/// The completion runs on the interpreter thread.
- (void)submitRequestJSON:(NSString *)requestJSON
              executionId:(nullable NSString *)executionId
               completion:(void (^)(NSString *responseJSON))completion
    NS_SWIFT_NAME(submit(requestJSON:executionId:completion:));

/// Requests that the running execution stop. Returns the mechanism used
/// ("input-cancelled", "keyboard-interrupt", "keyboard-interrupt+signal"),
/// or nil when `executionId` is not the active execution.
- (nullable NSString *)interruptExecution:(NSString *)executionId
    NS_SWIFT_NAME(interrupt(executionId:));

/// Supplies one line for a pending input() call. `text == nil` means EOF.
- (BOOL)provideInput:(nullable NSString *)text forExecution:(NSString *)executionId
    NS_SWIFT_NAME(provideInput(_:executionId:));

/// YES while the active execution is blocked in input().
- (BOOL)isWaitingForInput;

/// Queues a batch of UI events (a JSON array string) from the graphics
/// preview for the running execution; zinia_draw / zinia_3d read them with
/// _zinia_native.wait_ui(). Returns NO when `executionId` is not running.
- (BOOL)postUIEvents:(NSString *)eventsJSON forExecution:(NSString *)executionId
    NS_SWIFT_NAME(postUIEvents(_:executionId:));

@end

NS_ASSUME_NONNULL_END
