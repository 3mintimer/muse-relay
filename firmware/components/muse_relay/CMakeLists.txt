idf_component_register(SRCS "relay.c" "relay_ota.c" "diagnostics.c" "chat_filter.c" INCLUDE_DIRS "."
    REQUIRES app_update esp_app_format esp_http_client esp-tls nvs_flash esp_timer esp_driver_gpio mbedtls espressif__cjson
    PRIV_REQUIRES esp_driver_rmt esp_netif)
if(CONFIG_MUSE_RELAY_ATOMS3_LITE_LED)
    target_sources(${COMPONENT_LIB} PRIVATE "status_led.c")
endif()
target_include_directories(${COMPONENT_LIB} PRIVATE "${MUSE_SDK_DIR}/main")
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=app_run" "-Wl,-u,__wrap_app_run" "-Wl,-u,app_run")
