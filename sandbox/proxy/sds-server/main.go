package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"time"

	envoy_core_v3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	envoy_tls_v3 "github.com/envoyproxy/go-control-plane/envoy/extensions/transport_sockets/tls/v3"
	v3 "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"
	secretv3 "github.com/envoyproxy/go-control-plane/envoy/service/secret/v3"
	"github.com/envoyproxy/go-control-plane/pkg/resource/v3"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

var caCert *x509.Certificate
var caKey *rsa.PrivateKey

func loadCA(certPath, keyPath string) error {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return fmt.Errorf("read cert: %w", err)
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return fmt.Errorf("read key: %w", err)
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return fmt.Errorf("decode cert PEM failed")
	}
	caCert, err = x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return err
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return fmt.Errorf("decode key PEM failed")
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		keyAny, err = x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
		if err != nil {
			return fmt.Errorf("parse private key: %w", err)
		}
	}
	var ok bool
	caKey, ok = keyAny.(*rsa.PrivateKey)
	if !ok {
		return fmt.Errorf("CA key is not RSA")
	}

	return nil
}

func signLeafCert(domain string) ([]byte, []byte, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().Unix()),
		Subject:               pkix.Name{CommonName: domain},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(30 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              []string{domain, "*." + domain},
		BasicConstraintsValid: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	return certPEM, keyPEM, nil
}

func main() {
	certPath := os.Getenv("CA_CERT_PATH")
	keyPath := os.Getenv("CA_KEY_PATH")
	socketPath := os.Getenv("SDS_SOCKET_PATH")

	if certPath == "" {
		certPath = "/opt/fusebox/certs/ca/egress-gateway-ca-production.pem"
	}
	if keyPath == "" {
		keyPath = "/opt/fusebox/certs/ca/egress-ca.key"
	}
	if socketPath == "" {
		socketPath = "/var/run/envoy-sds.sock"
	}

	if err := loadCA(certPath, keyPath); err != nil {
		log.Fatalf("Failed to load CA: %v", err)
	}

	os.Remove(socketPath)
	lis, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("Failed to listen on %s: %v", socketPath, err)
	}

	grpcServer := grpc.NewServer()
	secretv3.RegisterSecretDiscoveryServiceServer(grpcServer, &sdsServer{})

	log.Printf("SDS server listening on %s", socketPath)
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("gRPC serve failed: %v", err)
	}
}

type sdsServer struct {
	secretv3.UnimplementedSecretDiscoveryServiceServer
}

func (s *sdsServer) StreamSecrets(stream secretv3.SecretDiscoveryService_StreamSecretsServer) error {
	for {
		req, err := stream.Recv()
		if err != nil {
			return err
		}

		for _, name := range req.ResourceNames {
			domain := name
			certPEM, keyPEM, err := signLeafCert(domain)
			if err != nil {
				log.Printf("Failed to sign cert for %s: %v", domain, err)
				continue
			}

			tlsCert := &envoy_tls_v3.TlsCertificate{
				CertificateChain: &envoy_core_v3.DataSource{
					Specifier: &envoy_core_v3.DataSource_InlineBytes{
						InlineBytes: certPEM,
					},
				},
				PrivateKey: &envoy_core_v3.DataSource{
					Specifier: &envoy_core_v3.DataSource_InlineBytes{
						InlineBytes: keyPEM,
					},
				},
			}

			secret := &envoy_tls_v3.Secret{
				Name: name,
				Type: &envoy_tls_v3.Secret_TlsCertificate{
					TlsCertificate: tlsCert,
				},
			}

			anyMsg, _ := proto.Marshal(secret)
			discovery := &v3.DiscoveryResponse{
				Resources: []*anypb.Any{
					{TypeUrl: resource.SecretType, Value: anyMsg},
				},
				TypeUrl: resource.SecretType,
			}

			if err := stream.Send(discovery); err != nil {
				return err
			}
			log.Printf("Signed leaf cert for: %s", domain)
		}
	}
}

func (s *sdsServer) FetchSecrets(ctx context.Context, req *v3.DiscoveryRequest) (*v3.DiscoveryResponse, error) {
	return &v3.DiscoveryResponse{TypeUrl: resource.SecretType}, nil
}
