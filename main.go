package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"context"
	"net"
	"path/filepath"
	"stratum/api"
)

func main() {
	port := flag.Int("port", 8080, "Port to run the HTTP server on")
	dbPath := flag.String("db", "data/db/papers.db", "Path to the DuckDB database file")
	workspace := flag.String("workspace", "", "Path to the local workspace root directory where projects are stored (default ~/StratumProjects)")
	flag.Parse()

	workspaceVal := *workspace
	if workspaceVal == "" {
		homeDir, err := os.UserHomeDir()
		if err == nil {
			workspaceVal = filepath.Join(homeDir, "StratumProjects")
		} else {
			workspaceVal = "StratumProjects"
		}
	}
	_ = os.MkdirAll(workspaceVal, 0755)

	args := flag.Args()
	if len(args) > 0 && args[0] == "mcp" {
		fmt.Fprintln(os.Stderr, "Starting Stratum MCP Server (stdio mode)...")
		srv := api.NewAPIServer("", *dbPath, workspaceVal)
		ctx := context.Background()
		if err := srv.RunMCPStdio(ctx); err != nil {
			log.Fatalf("MCP server failed: %v", err)
		}
		return
	}

	addr := fmt.Sprintf(":%d", *port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ERROR] Port %d is already in use (address already in use).\n\n", *port)
		fmt.Fprintln(os.Stderr, "To resolve this, you can:")
		fmt.Fprintf(os.Stderr, "  1. Run on a specific free port:              ./stratum -port <available-port>\n")
		fmt.Fprintf(os.Stderr, "  2. Let the OS assign any free port automatically:  ./stratum -port 0\n")
		os.Exit(1)
	}

	actualPort := listener.Addr().(*net.TCPAddr).Port

	fmt.Printf("Starting Stratum Web Server on http://localhost:%d...\n", actualPort)
	fmt.Printf("Integrated MCP SSE Server listening at http://localhost:%d/api/mcp\n", actualPort)

	srv := api.NewAPIServer(fmt.Sprintf(":%d", actualPort), *dbPath, workspaceVal)
	if err := srv.RegisterRoutes(); err != nil {
		log.Fatalf("Failed to register routes: %v", err)
	}
	if err := srv.StartWithListener(listener); err != nil {
		log.Fatalf("HTTP server failed: %v", err)
	}

	// Wait for interrupt signal to gracefully shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("Shutting down Stratum Web Server...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Stop(shutdownCtx); err != nil {
		log.Printf("Graceful shutdown failed: %v", err)
	}
	log.Println("Server exited cleanly")
}
