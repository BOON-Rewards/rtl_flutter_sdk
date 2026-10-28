// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Only development/CI overrides this dependency; exported consumers use the exact tag.
let nativeDependency: Package.Dependency = ProcessInfo.processInfo.environment["RTL_IOS_SDK_PATH"]
    .flatMap { $0.isEmpty ? nil : .package(name: "rtl_ios_sdk", path: $0) }
    ?? .package(url: "https://github.com/BOON-Rewards/rtl_ios_sdk.git", exact: "4.2.0")

let package = Package(
    name: "rtl_sdk",
    platforms: [.iOS("15.0")],
    products: [.library(name: "rtl-sdk", targets: ["rtl_sdk"])],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        nativeDependency
    ],
    targets: [
        .target(name: "rtl_sdk", dependencies: [
            .product(name: "FlutterFramework", package: "FlutterFramework"),
            .product(name: "RTLSdk", package: "rtl_ios_sdk")
        ])
    ]
)
