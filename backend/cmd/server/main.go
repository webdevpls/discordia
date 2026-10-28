package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"discordia/internal/server"
	"discordia/internal/sfu"
	"discordia/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func list(key, def string) []string {
	var out []string
	for _, s := range strings.Split(env(key, def), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func main() {
	addr := env("ADDR", ":8080")
	udpPort, err := strconv.Atoi(env("RTC_UDP_PORT", "7882"))
	if err != nil {
		log.Fatal("RTC_UDP_PORT inválida")
	}

	simLoss, _ := strconv.ParseFloat(env("RTC_SIM_LOSS", "0"), 64)
	if simLoss > 0 {
		log.Printf("ATENÇÃO: RTC_SIM_LOSS=%.0f%% — descartando pacotes de propósito (só para testes)", simLoss*100)
	}

	st, err := store.Open(env("DB_PATH", "discordia.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	sf, err := sfu.New(sfu.Config{
		UDPPort:    udpPort,
		PublicIPs:  list("RTC_PUBLIC_IP", ""),
		ICEServers: list("RTC_ICE_SERVERS", "stun:stun.l.google.com:19302"),
		SimLoss:    simLoss,
	})
	if err != nil {
		log.Fatal(err)
	}

	hub := server.NewHub(st, sf, list("ALLOWED_ORIGINS", "localhost:*,127.0.0.1:*"))
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.New(st, hub, env("STATIC_DIR", "")),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("discordia ouvindo em %s (WebRTC UDP :%d)", addr, udpPort)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
