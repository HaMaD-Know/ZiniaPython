//
//  App-Bridging-Header.h
//
//  Exposes ZiniaPython's Objective-C interpreter host to the Swift plugins.
//  Only ZPInterpreter.h is imported; CPython's own headers stay private to
//  ZPInterpreter.m.
//

#import "ZiniaPython/ZPInterpreter.h"
