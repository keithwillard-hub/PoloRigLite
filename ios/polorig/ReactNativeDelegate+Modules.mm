/**
 * Register UDPTransport with the TurboModule system.
 *
 * This provides module registration for ReactNativeDelegate using proper
 * method swizzling that avoids infinite recursion.
 */

#import <objc/runtime.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <ReactCommon/RCTTurboModule.h>

// Global storage for the original implementation
static IMP originalGetModuleClassIMP = NULL;

// Forward declaration of our replacement function
static Class udpTransportGetModuleClass(id self, SEL _cmd, const char *name);

// Category to inject UDPTransport module support
@interface RCTDefaultReactNativeFactoryDelegate (UDPTransportHook)
@end

@implementation RCTDefaultReactNativeFactoryDelegate (UDPTransportHook)

+ (void)load {
  // Use dispatch_async to main queue to ensure the class is fully registered
  dispatch_async(dispatch_get_main_queue(), ^{
    // Get the ReactNativeDelegate class (Swift subclass) or fall back to base class
    Class targetClass = NSClassFromString(@"polorig.ReactNativeDelegate");
    if (!targetClass) {
      targetClass = NSClassFromString(@"ReactNativeDelegate");
    }
    if (!targetClass) {
      targetClass = [RCTDefaultReactNativeFactoryDelegate class];
    }

    RCTLogInfo(@"[UDPTransport] Attempting to hook on class: %@", targetClass);

    SEL selector = @selector(getModuleClassFromName:);
    Method originalMethod = class_getInstanceMethod(targetClass, selector);

    if (!originalMethod) {
      RCTLogInfo(@"[UDPTransport] Method getModuleClassFromName: not found");
      return;
    }

    // Save the original implementation BEFORE setting the new one
    originalGetModuleClassIMP = method_getImplementation(originalMethod);

    if (!originalGetModuleClassIMP) {
      RCTLogInfo(@"[UDPTransport] Could not get original implementation");
      return;
    }

    // Set our new implementation
    IMP newIMP = (IMP)udpTransportGetModuleClass;
    method_setImplementation(originalMethod, newIMP);

    RCTLogInfo(@"[UDPTransport] Successfully hooked getModuleClassFromName:");
  });
}

@end

// Our replacement function - uses C function pointer to avoid block recursion issues
static Class udpTransportGetModuleClass(id self, SEL _cmd, const char *name) {
  // Check if this is UDPTransport
  if (name && strcmp(name, "UDPTransport") == 0) {
    // Try to find the class
    Class udpClass = NSClassFromString(@"UDPTransport");
    if (!udpClass) {
      udpClass = NSClassFromString(@"polorig.UDPTransport");
    }
    if (udpClass) {
      RCTLogInfo(@"[UDPTransport] Found and returning class: %@", udpClass);
      return udpClass;
    }
    RCTLogInfo(@"[UDPTransport] Class not found in bundle");
  }

  // Call the original implementation (stored in global variable)
  if (originalGetModuleClassIMP) {
    // Cast to proper function type and call
    Class (*origFunc)(id, SEL, const char *) = (Class (*)(id, SEL, const char *))originalGetModuleClassIMP;
    return origFunc(self, _cmd, name);
  }

  return nil;
}
