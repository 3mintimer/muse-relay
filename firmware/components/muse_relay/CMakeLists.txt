idf_component_register(SRCS "relay.c" "chat_filter.c" INCLUDE_DIRS "."
    REQUIRES esp_http_client esp-tls nvs_flash esp_timer esp_driver_gpio mbedtls espressif__cjson)
target_include_directories(${COMPONENT_LIB} PRIVATE "${MUSE_SDK_DIR}/main")
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=app_run" "-Wl,-u,__wrap_app_run" "-Wl,-u,app_run")
