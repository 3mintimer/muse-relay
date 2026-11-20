cmake_minimum_required(VERSION 3.16)

if(NOT MUSE_SDK_DIR)
    message(FATAL_ERROR "Use tools/build.sh or pass MUSE_SDK_DIR pointing to muse-gadget-sdk/esp32")
endif()
set(PROJECT_VER "0.1.4")
include("${MUSE_SDK_DIR}/cmake/project.cmake")
project(muse-relay)
include("${MUSE_SDK_DIR}/cmake/validate_config.cmake")
